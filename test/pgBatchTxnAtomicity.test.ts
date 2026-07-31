/**
 * Lock-in regression tests for the PostgreSQL adapter `_inTransaction`
 * transaction-atomicity bug.
 *
 * BUG (pre-fix): PostgresAdapter._inTransaction was declared and read but
 * NEVER assigned. So executeManyAsync()'s owns-guard `owns = !_inTransaction`
 * was ALWAYS true — a batch insert nested inside a caller's explicit
 * startTransactionAsync() opened its OWN inner BEGIN...COMMIT. The inner COMMIT
 * committed the caller's OUTER transaction early, and the caller's later
 * rollbackAsync() then undid nothing — the batch rows survived. Atomicity gone.
 *
 * FIX: startTransactionAsync() sets _inTransaction = true; commitAsync() and
 * rollbackAsync() clear it. Now owns correctly detects the outer transaction and
 * the batch JOINS it (no inner BEGIN/COMMIT). Standalone batches (no outer txn)
 * still own — and atomically commit — their own transaction, unchanged. Mirrors
 * the Python master (tina4_python/database/postgres.py start/commit/rollback +
 * adapter.py execute_many owns_txn guard).
 *
 * NO MOCKS — every assertion runs against a REAL PostgreSQL. Env-gated exactly
 * like the other pg tests (socket reachability + `pg` import probe); skips
 * cleanly when no PostgreSQL is reachable so CI without a container no-ops.
 *
 *   NEGATIVE (the bug): batch-in-explicit-txn is undone by rollback (count 0).
 *             FAILS on the old code (rows survive) — that is the regression lock.
 *   NEGATIVE via the real public batch entry: insertAsync(table, [rows]).
 *   POSITIVE: commit persists the batch — verified on a FRESH connection (durable).
 *   STANDALONE: a batch with no outer txn still auto-commits atomically...
 *   STANDALONE atomicity: ...and a bad row mid-batch rolls the whole batch back.
 *
 * Run with: npx tsx test/pgBatchTxnAtomicity.test.ts
 */
import net from "node:net";

const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "localhost";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "5432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USERNAME ?? "tina4";
const PG_PASS = process.env.TINA4_TEST_PG_PASSWORD ?? "tina4";
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

console.log("=== PostgreSQL batch-in-transaction atomicity (_inTransaction) ===\n");

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

const { PostgresAdapter } = await import("../packages/orm/src/adapters/postgres.ts");

const URL = `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}`;
const TABLE = "t4_batch_txn_atomicity";

async function newAdapter() {
  const a = new PostgresAdapter(URL);
  await a.connect();
  return a;
}

async function countRows(): Promise<number> {
  // Fresh connection each time — a durable COMMIT must be visible here, and a
  // rolled-back batch must NOT be, independent of any session that wrote it.
  const a = await newAdapter();
  try {
    const rows = await a.queryAsync<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE}`);
    return Number(rows[0].n);
  } finally {
    a.close();
  }
}

const setup = await newAdapter();
try {
  await setup.executeAsync(`DROP TABLE IF EXISTS ${TABLE}`);
  // UNIQUE(v) so the standalone-atomicity negative case can force a mid-batch failure.
  await setup.executeAsync(`CREATE TABLE ${TABLE} (id SERIAL PRIMARY KEY, v TEXT NOT NULL UNIQUE)`);

  const INSERT = `INSERT INTO ${TABLE} (v) VALUES (?)`;

  // ── 1. NEGATIVE — batch inside explicit txn is undone by rollback ──────
  // This is the regression lock: FAILS against the old code (rows survive).
  {
    const a = await newAdapter();
    try {
      await a.startTransactionAsync();
      await a.executeManyAsync(INSERT, [["n1"], ["n2"]]);
      await a.rollbackAsync();
    } finally {
      a.close();
    }
    assert(
      "executeManyAsync inside startTransaction is UNDONE by rollback (0 rows)",
      (await countRows()) === 0,
      `— batch survived the rollback (the _inTransaction bug); expected 0`,
    );
  }

  // ── 2. NEGATIVE via the real public batch entry: insertAsync(table, [rows]) ─
  {
    const a = await newAdapter();
    try {
      await a.startTransactionAsync();
      const res = await a.insertAsync(TABLE, [{ v: "i1" }, { v: "i2" }, { v: "i3" }]);
      assert("insertAsync(batch) reports success + 3 affected", res.success && res.affectedRows === 3);
      await a.rollbackAsync();
    } finally {
      a.close();
    }
    assert(
      "insertAsync(batch) inside startTransaction is UNDONE by rollback (0 rows)",
      (await countRows()) === 0,
      `— batch survived the rollback; expected 0`,
    );
  }

  // ── 3. POSITIVE — commit persists the batch (durable on a fresh conn) ─────
  {
    const a = await newAdapter();
    try {
      await a.startTransactionAsync();
      await a.executeManyAsync(INSERT, [["c1"], ["c2"]]);
      await a.commitAsync();
    } finally {
      a.close();
    }
    assert(
      "committed batch persists — visible on a fresh connection (2 rows)",
      (await countRows()) === 2,
      `expected 2 durable rows after commit`,
    );
    // Clean slate for the standalone cases.
    await setup.executeAsync(`DELETE FROM ${TABLE}`);
  }

  // ── 4. STANDALONE — a batch with no outer txn auto-commits atomically ─────
  {
    const a = await newAdapter();
    try {
      await a.executeManyAsync(INSERT, [["s1"], ["s2"], ["s3"]]);
    } finally {
      a.close();
    }
    assert(
      "standalone batch (no outer txn) auto-commits — visible on a fresh conn (3 rows)",
      (await countRows()) === 3,
      `expected 3 auto-committed rows`,
    );
    await setup.executeAsync(`DELETE FROM ${TABLE}`);
  }

  // ── 5. STANDALONE atomicity — a bad row mid-batch rolls the whole batch back ─
  // owns=true path must still wrap the batch in its own transaction: the UNIQUE
  // violation on the 2nd row must undo the 1st too (all-or-nothing).
  {
    const a = await newAdapter();
    let threw = false;
    try {
      // "dup" twice -> the 2nd insert violates UNIQUE(v) mid-batch.
      await a.executeManyAsync(INSERT, [["dup"], ["dup"], ["s3"]]);
    } catch {
      threw = true;
    } finally {
      a.close();
    }
    assert("standalone batch with a bad row throws", threw);
    assert(
      "standalone batch is atomic — a mid-batch failure rolls back the whole batch (0 rows)",
      (await countRows()) === 0,
      `partial batch write leaked; expected 0`,
    );
  }
} finally {
  try { await setup.executeAsync(`DROP TABLE IF EXISTS ${TABLE}`); } catch {}
  setup.close();
}

summaryAndExit(fail > 0 ? 1 : 0);
