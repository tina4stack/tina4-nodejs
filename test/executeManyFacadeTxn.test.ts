/**
 * Lock-in regression tests for the PUBLIC `Database.executeMany` FACADE
 * transaction-atomicity bug.
 *
 * BUG (pre-fix): the facade `Database.executeMany` (packages/orm/src/database.ts)
 * called adapterStartTransaction -> loop -> adapterCommit UNCONDITIONALLY. So a
 * batch nested inside a caller's explicit `db.startTransaction()` opened its OWN
 * inner BEGIN...COMMIT on the already-pinned connection. The inner COMMIT
 * committed the caller's OUTER transaction early, and the caller's later
 * `db.rollback()` then undid NOTHING — the batch rows survived. Atomicity gone.
 *
 * This is the FACADE twin of the adapter-level `_inTransaction` bug locked in by
 * test/pgBatchTxnAtomicity.test.ts. The adapter fix (owns-guard on
 * PostgresAdapter.executeManyAsync) does NOT cover this path because the facade
 * `executeMany` drives adapterStartTransaction/adapterExecute/adapterCommit
 * DIRECTLY — it never calls the adapter's executeManyAsync.
 *
 * FIX: the facade guards with `owns = !this.inExplicitTransaction()`
 * (inExplicitTransaction() = a pinned adapter in txStore from startTransaction()).
 * When inside an explicit txn, executeMany JOINS it (no inner BEGIN/COMMIT) so the
 * caller's commit/rollback decides the outcome. Standalone batches (no outer txn)
 * still own — and atomically commit — their own transaction, unchanged. Mirrors
 * the sibling execute()/insert()/update()/delete() owns-guard and the Python
 * master (Database.execute_many delegating to adapter.execute_many's owns_txn guard).
 *
 * NO MOCKS — every assertion runs against a REAL PostgreSQL through the public
 * Database facade. Env-gated exactly like test/pgBatchTxnAtomicity.test.ts (socket
 * reachability + `pg` import probe); skips cleanly when no PostgreSQL is reachable
 * so CI without a container no-ops.
 *
 *   NEGATIVE (the bug): db.executeMany inside db.startTransaction is undone by
 *             db.rollback (count 0). FAILS on the old code (rows survive) — that
 *             is the regression lock.
 *   POSITIVE: db.commit persists the batch — verified on a FRESH connection (durable).
 *   STANDALONE: db.executeMany with no outer txn still auto-commits atomically...
 *   STANDALONE atomicity: ...and a bad row mid-batch rolls the whole batch back.
 *
 * Run with: npx tsx test/executeManyFacadeTxn.test.ts
 */
import net from "node:net";

const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "localhost";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "5432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USER ?? "tina4";
const PG_PASS = process.env.TINA4_TEST_PG_PASS ?? "tina4";
const PG_DB = process.env.TINA4_TEST_PG_DB ?? "tina4_node";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function summaryAndExit(code = 0): never {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(code);
}

function pgReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.connect(PG_PORT, PG_HOST, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

console.log("=== Database.executeMany FACADE transaction atomicity ===\n");

const reachable = await pgReachable();
if (!reachable) {
  console.log(`  \x1b[33mSKIP\x1b[0m PostgreSQL not reachable at ${PG_HOST}:${PG_PORT} — skipping`);
  summaryAndExit(0);
}

try {
  await import("pg");
} catch {
  console.log(`  \x1b[33mSKIP\x1b[0m 'pg' package not installed — npm install pg`);
  summaryAndExit(0);
}

const { Database } = await import("../packages/orm/src/database.ts");

const URL = `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}`;
const TABLE = "t4_executemany_facade_txn";
const INSERT = `INSERT INTO ${TABLE} (v) VALUES (?)`;

async function newDb(): Promise<any> {
  return (Database as any).create(URL);
}

async function countRows(): Promise<number> {
  // FRESH connection each time — a durable COMMIT must be visible here, and a
  // rolled-back batch must NOT be, independent of any session that wrote it.
  const d = await newDb();
  try {
    const row = await d.fetchOne(`SELECT count(*)::int AS n FROM ${TABLE}`);
    return Number(row.n);
  } finally {
    d.close();
  }
}

const setup = await newDb();
try {
  await setup.execute(`DROP TABLE IF EXISTS ${TABLE}`);
  // UNIQUE(v) so the standalone-atomicity negative case can force a mid-batch failure.
  await setup.execute(`CREATE TABLE ${TABLE} (id SERIAL PRIMARY KEY, v TEXT NOT NULL UNIQUE)`);

  // ── 1. NEGATIVE — batch inside explicit txn is undone by rollback ──────
  // This is the regression lock: FAILS against the old code (rows survive).
  {
    const db = await newDb();
    try {
      await db.startTransaction();
      await db.executeMany(INSERT, [["n1"], ["n2"]]);
      await db.rollback();
    } finally {
      db.close();
    }
    assert(
      "db.executeMany inside db.startTransaction is UNDONE by db.rollback (0 rows)",
      (await countRows()) === 0,
      `— batch survived the rollback (the facade premature-commit bug); expected 0`,
    );
  }

  // ── 2. POSITIVE — commit persists the batch (durable on a fresh conn) ─────
  {
    const db = await newDb();
    try {
      await db.startTransaction();
      await db.executeMany(INSERT, [["c1"], ["c2"]]);
      await db.commit();
    } finally {
      db.close();
    }
    assert(
      "committed batch persists — visible on a FRESH connection (2 rows)",
      (await countRows()) === 2,
      `expected 2 durable rows after commit`,
    );
    await setup.execute(`DELETE FROM ${TABLE}`);
  }

  // ── 3. STANDALONE — a batch with no outer txn auto-commits atomically ─────
  {
    const db = await newDb();
    try {
      const results = await db.executeMany(INSERT, [["s1"], ["s2"], ["s3"]]);
      assert("standalone db.executeMany returns one result per row (3)", results.length === 3);
    } finally {
      db.close();
    }
    assert(
      "standalone batch (no outer txn) auto-commits — visible on a FRESH conn (3 rows)",
      (await countRows()) === 3,
      `expected 3 auto-committed rows`,
    );
    await setup.execute(`DELETE FROM ${TABLE}`);
  }

  // ── 4. STANDALONE atomicity — a bad row mid-batch rolls the whole batch back ─
  // owns=true path must still wrap the batch in its own transaction: the UNIQUE
  // violation on the 2nd row must undo the 1st too (all-or-nothing).
  {
    const db = await newDb();
    let threw = false;
    try {
      // "dup" twice -> the 2nd insert violates UNIQUE(v) mid-batch.
      await db.executeMany(INSERT, [["dup"], ["dup"], ["s3"]]);
    } catch {
      threw = true;
    } finally {
      db.close();
    }
    assert("standalone batch with a bad row throws", threw);
    assert(
      "standalone batch is atomic — a mid-batch failure rolls back the whole batch (0 rows)",
      (await countRows()) === 0,
      `partial batch write leaked; expected 0`,
    );
  }
} finally {
  try { await setup.execute(`DROP TABLE IF EXISTS ${TABLE}`); } catch {}
  setup.close();
}

summaryAndExit(fail > 0 ? 1 : 0);
