/**
 * Database contract tests - the behaviours apps depend on, locked against drift.
 *
 * Named after the contracts a real upgrade relies on (and that a silent
 * regression like the 3.13.37 `execute` change - raise -> return false - would
 * have broken):
 *
 *   * execute() RAISES on a SQL error (never silently returns false), so a
 *     failing write propagates and a transaction rolls back.
 *   * read-after-write within a request is consistent (the request-scoped cache
 *     is off by default and never serves a pre-write value).
 *   * getNextId() is strictly monotonic + unique across repeated calls (no
 *     duplicate keys from a cached MAX(id)).
 *   * transactions bracket correctly: commit persists, rollback discards.
 *
 * These run against a real SQLite database via the framework's own
 * Database/adapter. They are engine-agnostic in intent - the same contracts are
 * mirrored in the Python/PHP/Ruby suites
 * (tina4-python/tests/test_db_contracts.py).
 *
 * Run with: npx tsx test/dbContracts.test.ts
 */
import { initDatabase, closeDatabase, type Database } from "../packages/orm/src/index.ts";

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

async function captureThrow(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}

/** Fresh in-memory Database with the `items` table created. */
async function makeDb(): Promise<Database> {
  const db = await initDatabase({ url: "sqlite:///:memory:" });
  await db.execute(
    "CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, qty INTEGER)",
  );
  return db;
}

async function run() {
  // ── execute() RAISES ────────────────────────────────────────────
  console.log("\n--- execute() raises (never returns false) ---");
  {
    const db = await makeDb();
    const err = await captureThrow(() => db.execute("INSERT INTO does_not_exist (x) VALUES (1)"));
    assert("bad SQL raises (not returns false)", err !== null, "expected a throw");
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }
  {
    const db = await makeDb();
    await captureThrow(() => db.execute("THIS IS NOT VALID SQL"));
    assert("cause captured on getError() after the raise", !!db.getError());
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }
  {
    const db = await makeDb();
    await db.execute("INSERT INTO items (id, name) VALUES (1, 'a')");
    const err = await captureThrow(() => db.execute("INSERT INTO items (id, name) VALUES (1, 'dup')"));
    assert("constraint violation (duplicate PK) raises", err !== null, "expected a throw");
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }
  {
    const db = await makeDb();
    const result = await db.execute("INSERT INTO items (name, qty) VALUES ('a', 1)");
    assert("successful write is truthy (never false)", result !== false, `(got ${String(result)})`);
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── read-after-write consistency ────────────────────────────────
  console.log("\n--- read-after-write consistency ---");
  {
    const db = await makeDb();
    await db.execute("INSERT INTO items (name, qty) VALUES ('widget', 5)");
    const row = await db.fetchOne<{ qty: number }>("SELECT name, qty FROM items WHERE name = ?", ["widget"]);
    assert("insert is immediately visible", row?.qty === 5, `(got ${JSON.stringify(row)})`);
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }
  {
    const db = await makeDb();
    await db.execute("INSERT INTO items (id, name, qty) VALUES (1, 'a', 1)");
    await db.execute("UPDATE items SET qty = 99 WHERE id = 1");
    const row = await db.fetchOne<{ qty: number }>("SELECT qty FROM items WHERE id = 1");
    assert("update is immediately visible", row?.qty === 99, `(got ${JSON.stringify(row)})`);
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }
  {
    const db = await makeDb();
    let ok = true;
    for (let i = 1; i <= 5; i++) {
      await db.execute("INSERT INTO items (id, name) VALUES (?, ?)", [i, `n${i}`]);
      const row = await db.fetchOne<{ m: number }>("SELECT MAX(id) AS m FROM items");
      if (Number(row?.m) !== i) ok = false; // no stale pre-write MAX from a request cache
    }
    assert("MAX(id) reflects the latest write each iteration", ok);
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── getNextId() strict monotonicity + uniqueness ────────────────
  console.log("\n--- getNextId() monotonic + unique ---");
  {
    const db = await makeDb();
    const ids: number[] = [];
    for (let i = 0; i < 50; i++) ids.push(await db.getNextId("orders"));
    const sorted = [...ids].sort((a, b) => a - b);
    assert("getNextId sorted == issued (monotonic)", JSON.stringify(ids) === JSON.stringify(sorted));
    assert("getNextId all unique (no duplicates)", new Set(ids).size === ids.length);
    const contiguous = ids.every((v, i) => i === 0 || v - ids[i - 1] === 1);
    assert("getNextId contiguous (+1 each call)", contiguous, `(${ids[0]}..${ids[ids.length - 1]})`);
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }
  {
    const db = await makeDb();
    const a = await db.getNextId("table_a");
    const b = await db.getNextId("table_b");
    assert("independent sequences per table (both start at 1)", a === 1 && b === 1, `(${a},${b})`);
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── transaction bracketing ──────────────────────────────────────
  console.log("\n--- transaction bracketing (commit persists / rollback discards) ---");
  {
    const db = await makeDb();
    await db.startTransaction();
    await db.execute("INSERT INTO items (name) VALUES ('kept')");
    await db.commit();
    const row = await db.fetchOne<{ c: number }>("SELECT count(*) AS c FROM items WHERE name='kept'");
    assert("commit persists", Number(row?.c) === 1, `(got ${JSON.stringify(row)})`);
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }
  {
    const db = await makeDb();
    await db.execute("INSERT INTO items (name) VALUES ('before')");
    await db.startTransaction();
    await db.execute("INSERT INTO items (name) VALUES ('rolled')");
    await db.rollback();
    const rolled = await db.fetchOne<{ c: number }>("SELECT count(*) AS c FROM items WHERE name='rolled'");
    const before = await db.fetchOne<{ c: number }>("SELECT count(*) AS c FROM items WHERE name='before'");
    assert("rollback discards the in-transaction write", Number(rolled?.c) === 0, `(got ${JSON.stringify(rolled)})`);
    assert("rollback keeps the pre-transaction write", Number(before?.c) === 1, `(got ${JSON.stringify(before)})`);
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }
  {
    const db = await makeDb();
    await db.startTransaction();
    await db.execute("INSERT INTO items (id, name) VALUES (1, 'a')");
    const err = await captureThrow(() => db.execute("INSERT INTO items (id, name) VALUES (1, 'dup')"));
    if (err) await db.rollback();
    const row = await db.fetchOne<{ c: number }>("SELECT count(*) AS c FROM items");
    assert("a failed write inside a txn can roll the whole txn back", Number(row?.c) === 0, `(got ${JSON.stringify(row)})`);
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }
}

run()
  .catch((e) => {
    console.error("UNEXPECTED ERROR:", e);
    fail++;
  })
  .finally(() => {
    console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
    process.exit(fail > 0 ? 1 : 0);
  });
