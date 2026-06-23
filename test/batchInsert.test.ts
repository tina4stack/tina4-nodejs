/**
 * Regression test: db.insert(table, [rows]) batch-inserts ALL rows.
 *
 * Mirrors the tina4-python master fix. Each per-engine async adapter
 * (PostgreSQL/MySQL/MSSQL/Firebird) overrode insert() and only handled a single
 * object — it called Object.keys(data) unconditionally, so passing a LIST of
 * rows (db.insert("t", [{...}, {...}, {...}])) either crashed or built garbage
 * SQL, even though insert advertises `data: object | object[]` (single OR batch).
 * SQLite's sync insert already routed an array through executeMany; the async
 * adapters now do the same via executeManyAsync (ONE connection, one batch path).
 *
 * Contract locked in here (engine-agnostic):
 *   - all 3 rows land in the table (read back, count == 3)
 *   - the result reports rowsAffected == 3
 *   - lastInsertId is sensible where the engine surfaces one (SQLite)
 *
 * SQLite always runs (node:sqlite, temp file). Live PostgreSQL runs when
 * reachable, else SKIPs with reason "postgres … not reachable". MySQL/MSSQL are
 * gated-skip (not provisioned in CI).
 *
 * Run with: npx tsx test/batchInsert.test.ts
 */
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function skip(reason: string): void {
  console.log(`  \x1b[33mSKIP\x1b[0m ${reason}`);
}

function summaryAndExit(code = 0): never {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(code);
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.connect(port, host, () => {
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

const ROWS = [
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
  { name: "Eve", email: "eve@example.com" },
];

console.log("=== Batch insert: db.insert(table, [rows]) ===\n");

const { initDatabase, closeDatabase } = await import("../packages/orm/src/index.ts");

// ── SQLite (always) ──────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "tina4-batch-"));
{
  console.log("-- SQLite (node:sqlite, temp file) --");
  const db = await initDatabase({ url: `sqlite:///${join(tmp, "batch.db")}` });
  try {
    await db.execute(
      "CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT)",
    );

    const res = await db.insert("people", ROWS);
    assert("SQLite batch insert succeeds", res.success === true, JSON.stringify(res));
    assert(
      "SQLite reports rowsAffected == 3",
      res.rowsAffected === 3,
      `(got ${res.rowsAffected})`,
    );
    assert(
      "SQLite returns a sensible lastInsertId (3rd row)",
      Number(res.lastInsertId) === 3,
      `(got ${String(res.lastInsertId)})`,
    );

    const back = await db.fetch("SELECT name, email FROM people ORDER BY id");
    assert("SQLite read-back: all 3 rows present", back.records.length === 3, `(got ${back.records.length})`);
    assert(
      "SQLite read-back: values match the batch",
      (back.records[0] as any).name === "Alice" &&
        (back.records[1] as any).name === "Bob" &&
        (back.records[2] as any).email === "eve@example.com",
      JSON.stringify(back.records),
    );

    // Single-object insert must still work unchanged.
    const single = await db.insert("people", { name: "Frank", email: "frank@example.com" });
    assert("SQLite single-object insert still works", single.success === true && single.rowsAffected === 1);
    const total = await db.fetch("SELECT count(*) AS c FROM people");
    assert("SQLite total is 4 after single insert", Number((total.records[0] as any).c) === 4);

    // Empty array is a no-op, not a crash.
    const empty = await db.insert("people", []);
    assert("SQLite empty-array insert is a 0-row no-op", empty.success === true && empty.rowsAffected === 0);
  } catch (e) {
    assert("SQLite batch insert (no exception)", false, (e as Error).message);
  } finally {
    try { await closeDatabase(); } catch { /* ignore */ }
  }
}

// ── PostgreSQL (live, gated on reachability) ─────────────────────────
{
  console.log("\n-- PostgreSQL (live) --");
  const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "localhost";
  const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "5432", 10);
  const PG_USER = process.env.TINA4_TEST_PG_USER ?? "tina4";
  const PG_PASS = process.env.TINA4_TEST_PG_PASS ?? "tina4";
  const PG_DB = process.env.TINA4_TEST_PG_DB ?? "tina4_node";

  if (!(await reachable(PG_HOST, PG_PORT))) {
    skip(`postgres not reachable at ${PG_HOST}:${PG_PORT} — skipping`);
  } else {
    let hasPg = true;
    try {
      await import("pg");
    } catch {
      hasPg = false;
      skip("postgres 'pg' package not installed — npm install pg");
    }
    if (hasPg) {
      const URL = `postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}`;
      const db = await initDatabase({ url: URL });
      try {
        await db.execute("DROP TABLE IF EXISTS t4_batch_people");
        await db.execute(
          "CREATE TABLE t4_batch_people (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(255))",
        );

        const res = await db.insert("t4_batch_people", ROWS);
        assert("PG batch insert succeeds", res.success === true, JSON.stringify(res));
        assert(
          "PG reports rowsAffected == 3",
          res.rowsAffected === 3,
          `(got ${res.rowsAffected})`,
        );

        const back = await db.fetch("SELECT name, email FROM t4_batch_people ORDER BY id");
        assert("PG read-back: all 3 rows present", back.records.length === 3, `(got ${back.records.length})`);
        assert(
          "PG read-back: values match the batch",
          (back.records[0] as any).name === "Alice" &&
            (back.records[2] as any).email === "eve@example.com",
          JSON.stringify(back.records),
        );

        // Single-object insert (RETURNING *) still works + surfaces the id.
        const single = await db.insert("t4_batch_people", { name: "Frank", email: "frank@example.com" });
        assert(
          "PG single-object insert still works + returns id",
          single.success === true && single.rowsAffected === 1 && Number(single.lastInsertId) > 0,
          JSON.stringify(single),
        );

        const empty = await db.insert("t4_batch_people", []);
        assert("PG empty-array insert is a 0-row no-op", empty.success === true && empty.rowsAffected === 0);

        await db.execute("DROP TABLE IF EXISTS t4_batch_people");
      } catch (e) {
        assert("PG batch insert (no exception)", false, (e as Error).message);
      } finally {
        try { await closeDatabase(); } catch { /* ignore */ }
      }
    }
  }
}

// ── MySQL / MSSQL (not provisioned in CI — gated skip) ───────────────
{
  console.log("\n-- MySQL / MSSQL (gated) --");
  const MYSQL_HOST = process.env.TINA4_TEST_MYSQL_HOST;
  const MSSQL_HOST = process.env.TINA4_TEST_MSSQL_HOST;
  if (!MYSQL_HOST) skip("mysql not configured (TINA4_TEST_MYSQL_HOST unset) — skipping");
  if (!MSSQL_HOST) skip("mssql not configured (TINA4_TEST_MSSQL_HOST unset) — skipping");
}

try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

summaryAndExit(fail > 0 ? 1 : 0);
