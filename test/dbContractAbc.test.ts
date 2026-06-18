/**
 * Tina4 Node.js — DB-contract A + B + C correctness pass (mirrors the Python
 * master tests/test_db_contract_abc.py, 13 tests).
 *
 * THEME A — fetch / fetchOne / fetchAll FAIL LOUD on a SQL error and populate
 *           getError(); a failed read is never cached.
 * THEME B — getNextId() is ATOMIC: N concurrent callers get DISTINCT ids.
 * THEME C — commit() failure re-throws + retains the transaction pin; rollback
 *           always clears it; nested startTransaction() is guarded (depth).
 *
 * Run with: npx tsx test/dbContractAbc.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, closeDatabase } from "../packages/orm/src/index.ts";

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

/** Await `fn`, returning the thrown error (or null if it didn't throw). */
async function captureThrow(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}

console.log("=== DB Contract A+B+C (fail-loud reads, atomic getNextId, commit pin) ===\n");

const tmp = mkdtempSync(join(tmpdir(), "tina4-dbabc-"));

async function run() {
  // ── THEME A ────────────────────────────────────────────────────
  console.log("--- THEME A: fetch/fetchOne/fetchAll FAIL LOUD + getError ---");

  {
    const db = await initDatabase({ url: `sqlite:///${join(tmp, "a.db")}` });
    await db.execute("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)");
    await db.execute("INSERT INTO widgets (name) VALUES ('cog')");

    // fetch() on a bad table must RAISE, not return empty rows.
    {
      const err = await captureThrow(() => db.fetch("SELECT * FROM no_such_table"));
      assert("fetch raises on bad SQL (not empty result)", err !== null, "expected a throw");
      assert("fetch populates getError() after a bad SQL", !!db.getError());
    }

    // fetchOne() on a bad table must RAISE and populate getError().
    {
      const err = await captureThrow(() => db.fetchOne("SELECT * FROM no_such_table WHERE id = ?", [1]));
      assert("fetchOne raises on bad SQL", err !== null, "expected a throw");
      assert("fetchOne populates getError()", !!db.getError());
    }

    // fetchAll() inherits fetch() so it raises too.
    {
      const err = await captureThrow(() => db.fetchAll("SELECT * FROM no_such_table"));
      assert("fetchAll raises on bad SQL", err !== null, "expected a throw");
    }

    // fetchOne() on a bad COLUMN raises (not a silent empty row).
    {
      const err = await captureThrow(() => db.fetchOne("SELECT no_such_col FROM widgets"));
      assert("fetchOne bad column raises (not empty)", err !== null, "expected a throw");
    }

    // A successful read clears getError() back to null.
    {
      const row = await db.fetchOne<{ name: string }>("SELECT name FROM widgets WHERE id = ?", [1]);
      assert("successful read returns the row", row?.name === "cog");
      assert("successful read clears getError()", db.getError() === null);
    }

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // A failed read under TINA4_AUTO_CACHING is NOT cached: after creating the
  // missing table the same query returns the real row (nothing empty was served
  // from cache).
  {
    const prev = process.env.TINA4_AUTO_CACHING;
    process.env.TINA4_AUTO_CACHING = "true";
    try {
      const db = await initDatabase({ url: `sqlite:///${join(tmp, "a_cache.db")}` });

      // Query a missing table — must raise (and must NOT cache a null/empty).
      const err = await captureThrow(() => db.fetchOne("SELECT * FROM late_table WHERE id = ?", [1]));
      assert("cached-mode failed read still raises", err !== null, "expected a throw");

      // Now create the table + a row; the SAME query must return the real row,
      // proving the earlier failure was not cached as an empty result.
      await db.execute("CREATE TABLE late_table (id INTEGER PRIMARY KEY, val TEXT)");
      await db.execute("INSERT INTO late_table (id, val) VALUES (1, 'real')");
      const row = await db.fetchOne<{ val: string }>("SELECT * FROM late_table WHERE id = ?", [1]);
      assert("failed read is not cached (real row served after table created)", row?.val === "real");

      db.close();
      try { await closeDatabase(); } catch { /* ignore */ }
    } finally {
      if (prev === undefined) delete process.env.TINA4_AUTO_CACHING;
      else process.env.TINA4_AUTO_CACHING = prev;
    }
  }

  // ── THEME B ────────────────────────────────────────────────────
  console.log("\n--- THEME B: getNextId() atomic (no duplicate ids under concurrency) ---");

  {
    const db = await initDatabase({ url: `sqlite:///${join(tmp, "b_seq.db")}` });
    await db.execute("CREATE TABLE seq_items (id INTEGER PRIMARY KEY, name TEXT)");

    // Sequential sanity — contiguous ids starting at 1.
    const id1 = await db.getNextId("seq_items");
    const id2 = await db.getNextId("seq_items");
    const id3 = await db.getNextId("seq_items");
    assert("getNextId sequential 1,2,3", id1 === 1 && id2 === 2 && id3 === 3, `${id1},${id2},${id3}`);

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  {
    const db = await initDatabase({ url: `sqlite:///${join(tmp, "b_conc.db")}` });
    await db.execute("CREATE TABLE conc_items (id INTEGER PRIMARY KEY, name TEXT)");

    // Spawn N concurrent getNextId() calls for the SAME table; assert the
    // returned ids are ALL DISTINCT (the race-safe contract). In Node the race
    // window is the await points between read and increment — Promise.all
    // interleaves the async tasks at exactly those points.
    const N = 100;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => db.getNextId("conc_items")),
    );
    const ids = results
      .filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled")
      .map((r) => r.value);
    const errors = results.filter((r) => r.status === "rejected").length;
    const unique = new Set(ids);
    assert("concurrent getNextId: zero errors", errors === 0, `${errors} rejected`);
    assert("concurrent getNextId: all 100 returned", ids.length === N, `got ${ids.length}`);
    assert("concurrent getNextId: all ids DISTINCT (no duplicates)", unique.size === ids.length,
      `${unique.size} unique of ${ids.length}`);
    // Contiguous 1..N (sorted) — the sequence advanced exactly once per call.
    const sorted = [...ids].sort((a, b) => a - b);
    const contiguous = sorted.every((v, i) => v === i + 1);
    assert("concurrent getNextId: contiguous 1..N", contiguous, `min=${sorted[0]} max=${sorted[sorted.length - 1]}`);

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // ── THEME C ────────────────────────────────────────────────────
  console.log("\n--- THEME C: commit failure re-throws + retains pin; rollback clears; nested guard ---");

  // A commit that FAILS must throw, populate getError(), RETAIN the pin, and a
  // follow-up rollback on the same connection must clean up.
  {
    const db = await initDatabase({ url: `sqlite:///${join(tmp, "c_commit.db")}` });
    await db.execute("CREATE TABLE acct (id INTEGER PRIMARY KEY, bal INTEGER)");

    // Monkeypatch the underlying adapter's commit to throw ONCE.
    const adapter: any = db.getAdapter();
    const target: any = typeof adapter.getAdapter === "function" ? adapter.getAdapter() : adapter;
    const realCommit = target.commit.bind(target);
    let thrown = false;
    target.commit = () => {
      if (!thrown) {
        thrown = true;
        throw new Error("simulated commit failure");
      }
      return realCommit();
    };

    await db.startTransaction();
    await db.execute("INSERT INTO acct (id, bal) VALUES (1, 100)");

    const commitErr = await captureThrow(() => db.commit());
    assert("failed commit re-throws", commitErr !== null, "expected a throw");
    assert("failed commit populates getError()", !!db.getError());
    // Pin retained — db is still 'in a transaction' on the SAME connection.
    assert("failed commit retains the transaction pin",
      (db as any).inExplicitTransaction?.() === true || (db as any).txStore?.getStore?.()?.adapter != null,
      "pin should be retained after a failed commit");

    // Restore the real commit and roll back on the SAME pinned connection.
    target.commit = realCommit;
    const rbErr = await captureThrow(() => db.rollback());
    assert("follow-up rollback after failed commit succeeds", rbErr === null, rbErr ? rbErr.message : "");
    assert("rollback cleared the pin",
      (db as any).inExplicitTransaction?.() === false || (db as any).txStore?.getStore?.()?.adapter == null,
      "pin should be cleared after rollback");

    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // A SUCCESSFUL commit clears the pin.
  {
    const db = await initDatabase({ url: `sqlite:///${join(tmp, "c_ok.db")}` });
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await db.startTransaction();
    await db.execute("INSERT INTO t (id) VALUES (1)");
    await db.commit();
    assert("successful commit clears the pin",
      (db as any).txStore?.getStore?.()?.adapter == null, "pin should be cleared");
    const row = await db.fetchOne<{ id: number }>("SELECT id FROM t WHERE id = 1");
    assert("successful commit persisted the row", row?.id === 1);
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // rollback() always clears the pin (terminal cleanup).
  {
    const db = await initDatabase({ url: `sqlite:///${join(tmp, "c_rb.db")}` });
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await db.startTransaction();
    await db.execute("INSERT INTO t (id) VALUES (1)");
    await db.rollback();
    assert("rollback always clears the pin",
      (db as any).txStore?.getStore?.()?.adapter == null, "pin should be cleared");
    const row = await db.fetchOne<{ id: number }>("SELECT id FROM t WHERE id = 1");
    assert("rollback discarded the row", row == null);
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  // Nested startTransaction() is guarded: a 2nd begin warns + no-ops the inner
  // begin (depth 1->2); the inner commit unwinds to 1 keeping the pin; the
  // outer commit releases the pin; a single row persists.
  {
    const db = await initDatabase({ url: `sqlite:///${join(tmp, "c_nested.db")}` });
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");

    await db.startTransaction();
    const depth1 = (db as any).txStore?.getStore?.()?.depth;
    await db.startTransaction(); // nested begin — must be guarded (depth -> 2)
    const depth2 = (db as any).txStore?.getStore?.()?.depth;
    assert("nested startTransaction increments depth (1 -> 2)", depth1 === 1 && depth2 === 2, `${depth1},${depth2}`);

    await db.execute("INSERT INTO t (id, v) VALUES (1, 'x')");

    await db.commit(); // inner commit — just unwinds depth to 1, pin retained
    const depthAfterInner = (db as any).txStore?.getStore?.()?.depth;
    const pinAfterInner = (db as any).txStore?.getStore?.()?.adapter;
    assert("inner commit unwinds depth to 1, pin retained", depthAfterInner === 1 && pinAfterInner != null,
      `depth=${depthAfterInner} pin=${pinAfterInner != null}`);

    await db.commit(); // outer commit — the real one, releases the pin
    assert("outer commit releases the pin",
      (db as any).txStore?.getStore?.()?.adapter == null, "pin should be cleared");

    const rows = await db.fetchAll<{ id: number }>("SELECT * FROM t");
    assert("nested txn persisted exactly one row", rows.length === 1, `got ${rows.length}`);

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
    rmSync(tmp, { recursive: true, force: true });
    console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
    process.exit(fail > 0 ? 1 : 0);
  });
