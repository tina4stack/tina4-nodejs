/**
 * MSSQL provider contract — feature 11 (mssqlprovider_contract.json), parity with
 * tina4-python/tests/test_mssqlprovider_contract.py.
 *
 * MSSQL-DEC-01 + MSSQL-DEC-02 (OWNER-DECISIONS.md Batch 5, feature doc
 * 011-mssql-provider.md). Every case drives the lab's REAL SQL Server :1433
 * (sa → tina4_test) through the public Database facade → MssqlAdapter. No mocks.
 * Durability is read back on a SECOND, FRESH connection.
 *
 * MSSQL-DEC-01 (safe parameter handling): a Buffer parameter binds as VarBinary
 * and round-trips byte-for-byte. Before the fix a Buffer fell through to the
 * NVarChar default (a text encoding applied to the bytes), corrupting the write.
 *
 * MSSQL-DEC-02 (one pagination strategy): OFFSET/FETCH in all four. Node used to
 * branch to `TOP n` for the first page (skip 0); it now always uses OFFSET/FETCH,
 * proven by the offset window.
 *
 * Node does NOT emulate MSSQL RETURNING (only the Python adapter does); a
 * non-`id`-PK insert surfaces the correct generated id through SCOPE_IDENTITY,
 * which is column-name-independent (invariant mssql-nonid-pk-generated-id).
 *
 * Mutation-proof: revert Buffer→VarBinary → "a binary parameter round trips
 * intact" goes RED (the bytes come back corrupted). Force TOP / drop the offset →
 * "a paginated query returns a later page window with offset" goes RED ([1,2]).
 *
 * Run with: npx tsx test/mssqlProviderContract.test.ts
 */
import process from "node:process";
import net from "node:net";
import { Buffer } from "node:buffer";
// Import from SOURCE (not the "@tina4/orm" exports map, which resolves to the
// prebuilt dist bundle) so this contract exercises the CHANGED src adapter
// (packages/orm/src/adapters/mssql.ts), not a stale dist.
import { Database, createAdapterFromUrl } from "../packages/orm/src/index.js";

const HOST = process.env.TINA4_TEST_MSSQL_HOST ?? "127.0.0.1";
const PORT = parseInt(process.env.TINA4_TEST_MSSQL_PORT ?? "1433", 10);
const USER = process.env.TINA4_TEST_MSSQL_USERNAME ?? "sa";
const PASS = process.env.TINA4_TEST_MSSQL_PASSWORD ?? "TinaSQL123!Secure";
const DB = process.env.TINA4_TEST_MSSQL_DB ?? "tina4_test";

const NONID = "mssqlprov_nonid";   // a table whose PK is deliberately NOT `id`
const PARAMS = "mssqlprov_params";
const PAGE = "mssqlprov_page";
// A payload with a NUL byte and high bytes — corrupted by a text (NVarChar) bind.
const BIN = Buffer.from([0, 1, 255, 2, 16, 200, 0, 127]);

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

const mssqlUrl = (): string => `mssql://${USER}:${PASS}@${HOST}:${PORT}/${DB}`;

async function connect(): Promise<{ db: Database; adapter: any }> {
  const adapter: any = await createAdapterFromUrl(mssqlUrl());
  const db = new Database(adapter);
  db.setDbType("mssql");
  return { db, adapter };
}

async function drop(db: Database, table: string): Promise<void> {
  await db.execute(`IF OBJECT_ID('${table}', 'U') IS NOT NULL DROP TABLE ${table}`);
}

/** A fresh IDENTITY table with a NON-`id` PK so its identity restarts at 1. */
async function freshNonid(db: Database): Promise<void> {
  await drop(db, NONID);
  await db.execute(`CREATE TABLE ${NONID} (person_key INT IDENTITY(1,1) PRIMARY KEY, code VARCHAR(40) NOT NULL, qty INT)`);
}

async function freshParams(db: Database): Promise<void> {
  await drop(db, PARAMS);
  // Explicit NULL: FreeTDS / tedious runs ANSI_NULL_DFLT_OFF, so an unspecified
  // column is NOT NULL there — mark the optional columns nullable so a
  // single-column insert does not trip the other column's NOT NULL default.
  await db.execute(`CREATE TABLE ${PARAMS} (k INT PRIMARY KEY, txt VARCHAR(100) NULL, blob VARBINARY(100) NULL)`);
}

async function freshPage(db: Database): Promise<void> {
  await drop(db, PAGE);
  await db.execute(`CREATE TABLE ${PAGE} (id INT PRIMARY KEY, val VARCHAR(20))`);
  const vals = ["a", "b", "c", "d", "e"];
  for (let i = 0; i < vals.length; i++) {
    await db.execute(`INSERT INTO ${PAGE} (id, val) VALUES (?, ?)`, [i + 1, vals[i]]);
  }
}

/** Every row on a SECOND connection — the durability witness. */
async function freshRows(table: string, orderCol: string): Promise<Record<string, unknown>[]> {
  const { db, adapter } = await connect();
  try {
    const result = await db.fetch(`SELECT * FROM ${table} ORDER BY ${orderCol}`, [], 1000);
    return result.records as Record<string, unknown>[];
  } finally {
    try { await adapter.close(); } catch { /* ignore */ }
  }
}

async function withDb(fn: (db: Database) => Promise<void>): Promise<void> {
  const { db, adapter } = await connect();
  try {
    await fn(db);
  } finally {
    for (const t of [NONID, PARAMS, PAGE]) {
      try { await drop(db, t); } catch { /* ignore */ }
    }
    try { await adapter.close(); } catch { /* ignore */ }
  }
}

async function run(): Promise<void> {
  if (!(await tcpReachable(HOST, PORT))) {
    skip(`no reachable MSSQL at ${HOST}:${PORT} (set TINA4_TEST_MSSQL_*)`);
    console.log(`\nmssqlProviderContract: ${pass} passed, ${fail} failed (MSSQL unreachable)`);
    return;
  }

  // ── mssql-nonid-pk-generated-id ──────────────────────────────────────────
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

  // ── mssql-safe-params ────────────────────────────────────────────────────
  await withDb(async (db) => {
    await freshParams(db);
    await db.execute(`INSERT INTO ${PARAMS} (k, blob) VALUES (?, ?)`, [1, BIN]);
    const { db: db2, adapter } = await connect();
    let got: Buffer = Buffer.alloc(0);
    try {
      const row = await db2.fetchOne<{ blob: Buffer }>(`SELECT blob FROM ${PARAMS} WHERE k = ?`, [1]);
      if (row && row.blob != null) got = Buffer.from(row.blob as Buffer);
    } finally {
      try { await adapter.close(); } catch { /* ignore */ }
    }
    check(
      "a binary parameter round trips intact",
      got.toString("hex") === BIN.toString("hex"),
      `sent=${BIN.toString("hex")} got=${got.toString("hex")}`,
    );
  });

  await withDb(async (db) => {
    await freshParams(db);
    const text = "it's a \"quoted\" O'Brien value";
    await db.execute(`INSERT INTO ${PARAMS} (k, txt) VALUES (?, ?)`, [2, text]);
    const { db: db2, adapter } = await connect();
    let value: unknown = null;
    try {
      const row = await db2.fetchOne<{ txt: string }>(`SELECT txt FROM ${PARAMS} WHERE k = ?`, [2]);
      value = row?.txt ?? null;
    } finally {
      try { await adapter.close(); } catch { /* ignore */ }
    }
    check("a text parameter round trips intact", value === text, `sent=${text} got=${String(value)}`);
  });

  // ── mssql-offset-fetch-pagination ────────────────────────────────────────
  await withDb(async (db) => {
    await freshPage(db);
    const result = await db.fetch(`SELECT id, val FROM ${PAGE} ORDER BY id`, [], 2, 0);
    const ids = result.records.map((r) => Number((r as Record<string, unknown>).id));
    check("a paginated query returns the first page window", JSON.stringify(ids) === JSON.stringify([1, 2]), `ids=${JSON.stringify(ids)}`);
  });

  await withDb(async (db) => {
    await freshPage(db);
    const result = await db.fetch(`SELECT id, val FROM ${PAGE} ORDER BY id`, [], 2, 2);
    const ids = result.records.map((r) => Number((r as Record<string, unknown>).id));
    const vals = result.records.map((r) => (r as Record<string, unknown>).val);
    // OFFSET/FETCH; a TOP-only strategy that ignores the offset returns [1, 2].
    check(
      "a paginated query returns a later page window with offset",
      JSON.stringify(ids) === JSON.stringify([3, 4]) && JSON.stringify(vals) === JSON.stringify(["c", "d"]),
      `ids=${JSON.stringify(ids)} vals=${JSON.stringify(vals)}`,
    );
  });

  console.log(`\nmssqlProviderContract: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
