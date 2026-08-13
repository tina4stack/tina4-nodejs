/**
 * PostgreSQL provider as the write-path ORACLE — feature 9 (pgprovider_contract.json),
 * parity with tina4-python/tests/test_pgprovider_contract.py.
 *
 * PG-DEC-01 (OWNER-DECISIONS.md Batch 5, feature 009-postgresql-provider.md): make the
 * adapter-contract test assert real write-path BEHAVIOUR — not just method presence —
 * with PostgreSQL as the reference model. PostgreSQL is the oracle for the write
 * contract: native RETURNING gives the true generated last-id, the transaction is real,
 * and the affected count is exact.
 *
 * Every case drives the lab's REAL PostgreSQL :55432 (tina4/tina4 → tina4_node) through
 * the public Database facade → PostgresAdapter. No mocks. Durability is read back on a
 * SECOND, FRESH connection where that is the property under test. The oracle table has a
 * SERIAL key and is dropped + recreated per case, so the RETURNING-generated id is
 * deterministic (first insert → 1, second → 2).
 *
 * Under TINA4_REQUIRE_SERVICES a skip here is a hard failure — these MUST run on the lab.
 *
 * Mutation-proof: make Database.executeMany() skip its transaction (execute each row
 * standalone) and "execute many mid batch failure rolls back on a fresh connection" goes
 * RED (the first row survives); drop the filterless-write guard and the guard cases go RED.
 */
import process from "node:process";
import net from "node:net";
import { Database, createAdapterFromUrl } from "@tina4/orm";

const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "127.0.0.1";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "55432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USERNAME ?? "tina4";
const PG_PASS = process.env.TINA4_TEST_PG_PASSWORD ?? "tina4";
const PG_DB = process.env.TINA4_TEST_PG_DB ?? "tina4_node";

const TABLE = "pgprovider_oracle";

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

const pgUrl = (): string => `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}`;

async function connect(): Promise<{ db: Database; adapter: any }> {
  const adapter: any = await createAdapterFromUrl(pgUrl());
  const db = new Database(adapter);
  db.setDbType("postgres");
  return { db, adapter };
}

/**
 * Every row on a SECOND connection — the durability witness. A write visible only
 * on the connection that made it is not durable.
 */
async function freshRows(): Promise<Record<string, unknown>[]> {
  const { db, adapter } = await connect();
  try {
    const result = await db.fetch(`SELECT * FROM ${TABLE} ORDER BY id`, [], 1000);
    return result.records as Record<string, unknown>[];
  } finally {
    try { await adapter.close(); } catch { /* ignore */ }
  }
}

/** Run `fn` against a fresh, empty oracle table so SERIAL restarts at 1 each case. */
async function withTable(fn: (db: Database) => Promise<void>): Promise<void> {
  const { db, adapter } = await connect();
  try {
    await db.execute(`DROP TABLE IF EXISTS ${TABLE}`);
    await db.execute(
      `CREATE TABLE ${TABLE} (id SERIAL PRIMARY KEY, code VARCHAR(40) NOT NULL UNIQUE, qty INTEGER)`,
    );
    await fn(db);
  } finally {
    try { await db.execute(`DROP TABLE IF EXISTS ${TABLE}`); } catch { /* ignore */ }
    try { await adapter.close(); } catch { /* ignore */ }
  }
}

async function run(): Promise<void> {
  if (!(await tcpReachable(PG_HOST, PG_PORT))) {
    skip(`no reachable postgres at ${PG_HOST}:${PG_PORT} (set TINA4_TEST_PG_*)`);
    console.log(`\npgProviderContract: ${pass} passed, ${fail} failed (postgres unreachable)`);
    return;
  }

  // ── pg-insert-returning-last-id ──────────────────────────────────────────
  await withTable(async (db) => {
    const result = await db.insert(TABLE, { code: "a", qty: 10 });
    const rows = await freshRows();
    check(
      "insert returns the returning generated last id",
      Number(result.lastId) === 1 && rows.length === 1 && Number(rows[0]!.id) === 1 && rows[0]!.code === "a",
      `lastId=${String(result.lastId)} rows=${JSON.stringify(rows)}`,
    );
  });

  await withTable(async (db) => {
    const result = await db.insert(TABLE, { code: "a", qty: 10 });
    check("insert reports affected rows of one", result.affectedRows === 1, `affectedRows=${result.affectedRows}`);
  });

  await withTable(async (db) => {
    const first = await db.insert(TABLE, { code: "a", qty: 10 });
    const second = await db.insert(TABLE, { code: "b", qty: 20 });
    check(
      "a second insert returns the next generated id not a stale one",
      Number(first.lastId) === 1 && Number(second.lastId) === 2 && second.lastId !== first.lastId,
      `first=${String(first.lastId)} second=${String(second.lastId)}`,
    );
  });

  // ── pg-write-affected-count ──────────────────────────────────────────────
  await withTable(async (db) => {
    await db.insert(TABLE, { code: "a", qty: 10 });
    await db.insert(TABLE, { code: "b", qty: 20 });
    await db.insert(TABLE, { code: "c", qty: 40 });
    const result = await db.update(TABLE, { qty: 99 }, "qty < ?", [30]);
    check("update reports the exact number of rows changed", result.affectedRows === 2, `affectedRows=${result.affectedRows}`);
  });

  await withTable(async (db) => {
    await db.insert(TABLE, { code: "a", qty: 10 });
    const result = await db.update(TABLE, { qty: 99 }, "code = ?", ["a"]);
    check(
      "update reports a null last id",
      result.lastId === null || result.lastId === undefined,
      `lastId=${String(result.lastId)}`,
    );
  });

  await withTable(async (db) => {
    await db.insert(TABLE, { code: "a", qty: 10 });
    await db.insert(TABLE, { code: "b", qty: 20 });
    const result = await db.delete(TABLE, { code: "a" });
    const rows = await freshRows();
    check(
      "delete reports the exact number of rows removed",
      result.affectedRows === 1 && rows.length === 1 && rows[0]!.code === "b",
      `affectedRows=${result.affectedRows} rows=${JSON.stringify(rows)}`,
    );
  });

  // ── pg-filterless-write-guard ────────────────────────────────────────────
  await withTable(async (db) => {
    await db.insert(TABLE, { code: "a", qty: 10 });
    await db.insert(TABLE, { code: "b", qty: 20 });
    let raised = false;
    try { await db.update(TABLE, { qty: 1 }); } catch { raised = true; }
    const rows = await freshRows();
    const byCode: Record<string, number> = {};
    for (const r of rows) byCode[String((r as any).code)] = Number((r as any).qty);
    check(
      "update without a filter or primary key raises and changes nothing",
      raised && rows.length === 2 && byCode.a === 10 && byCode.b === 20,
      `raised=${raised} rows=${JSON.stringify(rows)}`,
    );
  });

  await withTable(async (db) => {
    await db.insert(TABLE, { code: "a", qty: 10 });
    await db.insert(TABLE, { code: "b", qty: 20 });
    let raised = false;
    try { await db.delete(TABLE); } catch { raised = true; }
    const rows = await freshRows();
    check(
      "delete without a filter raises and removes nothing",
      raised && rows.length === 2,
      `raised=${raised} rows=${rows.length}`,
    );
  });

  // ── pg-executemany-atomicity ─────────────────────────────────────────────
  await withTable(async (db) => {
    // RETURNING forces the row-at-a-time loop (the batch collapser rejects it), so
    // the first set really executes inside the owned transaction before the second
    // set violates UNIQUE(code). One owned transaction → the failure rolls the whole
    // batch back and a fresh connection sees ZERO rows.
    let raised = false;
    try {
      await db.executeMany(`INSERT INTO ${TABLE} (code, qty) VALUES (?, ?) RETURNING *`, [["dup", 1], ["dup", 2]]);
    } catch { raised = true; }
    const rows = await freshRows();
    check(
      "execute many mid batch failure rolls back on a fresh connection",
      raised && rows.length === 0,
      `raised=${raised} rows=${JSON.stringify(rows)}`,
    );
  });

  await withTable(async (db) => {
    let threw = false;
    try { await db.executeMany(`INSERT INTO ${TABLE} (code, qty) VALUES (?, ?)`, []); } catch { threw = true; }
    const rows = await freshRows();
    check("execute many empty input is a zero row no op", !threw && rows.length === 0, `threw=${threw} rows=${rows.length}`);
  });

  // ── pg-fetch-shape ───────────────────────────────────────────────────────
  await withTable(async (db) => {
    await db.insert(TABLE, { code: "x", qty: 42 });
    const result = await db.fetch(`SELECT id, code, qty FROM ${TABLE} ORDER BY id`);
    const row = (result.records[0] ?? {}) as any;
    // pg returns an int4 column as a native JS number — PostgreSQL's native type.
    check(
      "fetch returns a native list of rows with native types",
      Array.isArray(result.records) && result.records.length === 1 && typeof row.qty === "number" && row.qty === 42 && row.code === "x",
      `records=${JSON.stringify(result.records)}`,
    );
  });

  await withTable(async (db) => {
    await db.insert(TABLE, { code: "y", qty: 7 });
    const row = (await db.fetchOne(`SELECT code, qty FROM ${TABLE} WHERE code = ?`, ["y"])) as any;
    check(
      "fetch one returns a single native record",
      row !== null && typeof row === "object" && row.code === "y" && typeof row.qty === "number" && row.qty === 7,
      `row=${JSON.stringify(row)}`,
    );
  });

  await withTable(async (db) => {
    const row = await db.fetchOne(`SELECT * FROM ${TABLE} WHERE code = ?`, ["nope"]);
    check("fetch one with no match returns null", row === null, `row=${JSON.stringify(row)}`);
  });

  console.log(`\npgProviderContract: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
