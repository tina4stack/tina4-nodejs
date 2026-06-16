/**
 * Regression tests for the pool round-robin transaction atomicity bug.
 *
 * Before the adapter-pin fix, every Database method call rotated to a
 * different pooled connection. Result: startTransaction() pinned BEGIN on
 * adapter A, the executes autocommitted on adapters B and C, and the final
 * commit/rollback landed on adapter D — meaningless. Rollbacks were silently
 * no-op'd and writes leaked through.
 *
 * These tests fail (3 rows leaking despite rollback) before the AsyncLocalStorage
 * pin in Database.getNextAdapter() and pass after it.
 *
 * Mirrors the Python regression at tina4-python/tests/test_database.py
 * ::TestPoolTransactionAtomicity.
 *
 * Run with: npx tsx test/poolTransactionAtomicity.test.ts
 */
import { Database } from "../packages/orm/src/database.ts";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

console.log("=== Pool Transaction Atomicity Tests ===\n");

const tmpDir = "/tmp/tina4-pool-tx-test";
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

async function makePool(name: string, pool: number): Promise<Database> {
  const path = join(tmpDir, name);
  rmSync(path, { force: true });
  const db = await Database.create(`sqlite:///${path}`, undefined, undefined, pool);
  await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
  return db;
}

// ── 1. rollback() under pool > 0 actually rolls back ─────────────
{
  console.log("--- rollback() must undo all inserts under pool=4 ---");
  const db = await makePool("rollback.db", 4);

  await db.startTransaction();
  await db.execute("INSERT INTO t (id, val) VALUES (1, 'a')");
  await db.execute("INSERT INTO t (id, val) VALUES (2, 'b')");
  await db.execute("INSERT INTO t (id, val) VALUES (3, 'c')");
  await db.rollback();

  const row = await db.fetchOne<{ n: number }>("SELECT count(*) AS n FROM t");
  const n = Number(row?.n ?? -1);
  assert(
    "rollback() under pool=4 leaks zero rows",
    n === 0,
    `expected 0 rows, got ${n} — adapter pin not honoured`,
  );
  db.close();
}

// ── 2. commit() under pool > 0 actually commits ──────────────────
{
  console.log("\n--- commit() must persist all inserts under pool=4 ---");
  const db = await makePool("commit.db", 4);

  await db.startTransaction();
  await db.execute("INSERT INTO t (id, val) VALUES (10, 'x')");
  await db.execute("INSERT INTO t (id, val) VALUES (20, 'y')");
  await db.execute("INSERT INTO t (id, val) VALUES (30, 'z')");
  await db.commit();

  const row = await db.fetchOne<{ n: number }>("SELECT count(*) AS n FROM t");
  const n = Number(row?.n ?? -1);
  assert(
    "commit() under pool=4 persists all 3 rows",
    n === 3,
    `expected 3 rows, got ${n}`,
  );
  db.close();
}

// ── 3. Pin released after commit — round-robin resumes ───────────
{
  console.log("\n--- pin released after commit (round-robin resumes) ---");
  const db = await makePool("releaseCommit.db", 4);

  await db.startTransaction();
  await db.commit();

  // After commit, getAdapter() should rotate again. Sample a few times
  // and confirm we see more than one distinct adapter.
  const seen = new Set<unknown>();
  for (let i = 0; i < 8; i++) {
    seen.add(db.getAdapter());
  }
  assert(
    "round-robin resumes after commit (>1 distinct adapter seen)",
    seen.size > 1,
    `only saw ${seen.size} distinct adapter(s) — pin still active`,
  );
  db.close();
}

// ── 4. Pin released after rollback — round-robin resumes ─────────
{
  console.log("\n--- pin released after rollback (round-robin resumes) ---");
  const db = await makePool("releaseRollback.db", 4);

  await db.startTransaction();
  await db.rollback();

  const seen = new Set<unknown>();
  for (let i = 0; i < 8; i++) {
    seen.add(db.getAdapter());
  }
  assert(
    "round-robin resumes after rollback (>1 distinct adapter seen)",
    seen.size > 1,
    `only saw ${seen.size} distinct adapter(s) — pin still active`,
  );
  db.close();
}

// ── 5. pool=0 (single connection) still works ────────────────────
{
  console.log("\n--- pool=0 single-connection mode still works ---");
  const db = await makePool("nopool.db", 0);

  await db.startTransaction();
  await db.execute("INSERT INTO t (id, val) VALUES (1, 'r')");
  await db.rollback();

  const row = await db.fetchOne<{ n: number }>("SELECT count(*) AS n FROM t");
  const n = Number(row?.n ?? -1);
  assert(
    "pool=0 rollback still works (no regression)",
    n === 0,
    `expected 0 rows, got ${n}`,
  );
  db.close();
}

// ── 6. Standalone write auto-commits and is visible across pool ──
{
  console.log("\n--- standalone write auto-commits, visible across pool ---");
  const db = await makePool("standalone.db", 3);

  // No startTransaction() — these are standalone writes that must commit
  // on their own connection so any round-robin connection sees them.
  await db.execute("INSERT INTO t (id, val) VALUES (100, 'p')");
  await db.execute("INSERT INTO t (id, val) VALUES (200, 'q')");

  let allVisible = true;
  for (let i = 0; i < 8; i++) {
    const row = await db.fetchOne<{ n: number }>("SELECT count(*) AS n FROM t");
    if (Number(row?.n ?? -1) !== 2) allVisible = false;
  }
  assert(
    "standalone writes visible across pooled connections (autocommit on)",
    allVisible,
    "a standalone write was not visible from a round-robin connection",
  );
  db.close();
}

// ── Cleanup ──────────────────────────────────────────────────────
rmSync(tmpDir, { recursive: true, force: true });

console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
