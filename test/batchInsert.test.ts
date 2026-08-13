/**
 * Regression test: db.insert(table, [rows]) batch-inserts ALL rows atomically.
 *
 * Mirrors the tina4-python master fix. Each per-engine async adapter
 * (PostgreSQL/MySQL/MSSQL/Firebird) overrode insert() and only handled a single
 * object — it called Object.keys(data) unconditionally, so passing a LIST of
 * rows (db.insert("t", [{...}, {...}, {...}])) either crashed or built garbage
 * SQL, even though insert advertises `data: object | object[]` (single OR batch).
 * SQLite's sync insert already routed an array through executeMany; the async
 * adapters now do the same via executeManyAsync (ONE connection, one batch path).
 *
 * Full batch contract locked in here for EVERY reachable engine (engine-agnostic):
 *   1. all 3 rows land in the table (read back, count == 3)
 *   2. the result reports affectedRows == 3
 *   3. a single-object insert still works (affectedRows == 1)
 *   4. an empty array is a 0-row no-op, not a crash
 *   5. a bad row (NULL into a NOT NULL column) rolls the WHOLE batch back as one
 *      transaction — no partial write (post-insert count is unchanged)
 * plus a sensible lastId where the engine surfaces one.
 *
 * NO MOCKS: SQLite always runs (node:sqlite, temp file); PostgreSQL, MySQL and
 * MSSQL run against the live containers when reachable + their driver is
 * installed, else SKIP with an engine-named reason. Under TINA4_REQUIRE_SERVICES
 * the run-all gate turns an unreachable provisioned engine into a hard failure.
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

async function count(db: any, table: string): Promise<number> {
  const r = await db.fetch(`SELECT count(*) AS c FROM ${table}`);
  return Number((r.records[0] as any).c);
}

/**
 * Run the full 5-point batch contract against one live engine. `lastId` selects
 * how the engine surfaces the batch's last insert id: "exact3" (SQLite autoinc),
 * "positive" (MySQL AUTO_INCREMENT / PG SERIAL), or "none" (MSSQL batch path
 * tracks no per-row id). No mocks — `db` is a real adapter on a real engine.
 */
async function batchContract(
  label: string,
  db: any,
  table: string,
  lastId: "exact3" | "positive" | "none",
): Promise<void> {
  // 1 + 2: all three rows land, affectedRows == 3.
  const res = await db.insert(table, ROWS);
  assert(`${label} batch insert succeeds`, res.success === true, JSON.stringify(res));
  assert(`${label} reports affectedRows == 3`, res.affectedRows === 3, `(got ${res.affectedRows})`);
  if (lastId === "exact3") {
    assert(`${label} lastId is the 3rd row`, Number(res.lastId) === 3, `(got ${String(res.lastId)})`);
  } else if (lastId === "positive") {
    assert(`${label} lastId is a positive id`, Number(res.lastId) > 0, `(got ${String(res.lastId)})`);
  }

  const back = await db.fetch(`SELECT name, email FROM ${table} ORDER BY name`);
  assert(`${label} read-back: all 3 rows present`, back.records.length === 3, `(got ${back.records.length})`);
  assert(
    `${label} read-back: values match the batch`,
    (back.records[0] as any).name === "Alice" &&
      (back.records[1] as any).name === "Bob" &&
      (back.records[2] as any).email === "eve@example.com",
    JSON.stringify(back.records),
  );

  // 3: single-object insert is unaffected.
  const single = await db.insert(table, { name: "Frank", email: "frank@example.com" });
  assert(`${label} single-object insert still works`, single.success === true && single.affectedRows === 1, JSON.stringify(single));
  assert(`${label} total is 4 after single insert`, (await count(db, table)) === 4);

  // 4: empty array is a 0-row no-op, not a crash.
  const empty = await db.insert(table, []);
  assert(`${label} empty-array insert is a 0-row no-op`, empty.success === true && empty.affectedRows === 0, JSON.stringify(empty));

  // 5: a bad row (NULL into NOT NULL name) rolls the WHOLE batch back — atomic.
  // Adapters report the failure two ways (both acceptable): the sync SQLite path
  // throws; the async adapters catch and return { success: false }. Either way the
  // contract is "no partial write" — the post-insert count must be unchanged.
  const before = await count(db, table);
  let failed = false;
  try {
    const bad = await db.insert(table, [
      { name: "rb1", email: "rb1@example.com" },
      { name: "rb2", email: "rb2@example.com" },
      { name: null, email: "rbbad@example.com" }, // violates NOT NULL
    ]);
    failed = bad.success === false;
  } catch {
    failed = true;
  }
  assert(`${label} bad-row batch fails (no partial insert)`, failed, "batch with a bad row should not succeed");
  const after = await count(db, table);
  assert(`${label} bad-row batch rolled back as one transaction (count unchanged)`, after === before, `before=${before} after=${after}`);
}

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
    await batchContract("SQLite", db, "people", "exact3");
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
  const PG_USER = process.env.TINA4_TEST_PG_USERNAME ?? "tina4";
  const PG_PASS = process.env.TINA4_TEST_PG_PASSWORD ?? "tina4";
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
        // PG's batch path surfaces no per-row id (plain INSERTs, no RETURNING in
        // the batch loop), so lastId is not asserted for the batch.
        await batchContract("PG", db, "t4_batch_people", "none");
        await db.execute("DROP TABLE IF EXISTS t4_batch_people");
      } catch (e) {
        assert("PG batch insert (no exception)", false, (e as Error).message);
      } finally {
        try { await closeDatabase(); } catch { /* ignore */ }
      }
    }
  }
}

// ── MySQL (live, gated on reachability + the mysql2 driver) ──────────
{
  console.log("\n-- MySQL (live) --");
  // 127.0.0.1, not "localhost": mysql2 treats the literal host "localhost" as a
  // UNIX-socket request (ignoring the port), so a TCP-only MySQL is unreachable
  // under that default.
  const HOST = process.env.TINA4_TEST_MYSQL_HOST ?? "127.0.0.1";
  const PORT = parseInt(process.env.TINA4_TEST_MYSQL_PORT ?? "3306", 10);
  const USER = process.env.TINA4_TEST_MYSQL_USERNAME ?? "tina4";
  const PASS = process.env.TINA4_TEST_MYSQL_PASSWORD ?? "tina4";
  const DB = process.env.TINA4_TEST_MYSQL_DB ?? "tina4_test";

  if (!(await reachable(HOST, PORT))) {
    skip(`mysql not reachable at ${HOST}:${PORT} — skipping`);
  } else {
    let hasDriver = true;
    try {
      await import("mysql2");
    } catch {
      hasDriver = false;
      skip("mysql2 driver not installed — npm install mysql2");
    }
    if (hasDriver) {
      const URL = `mysql://${USER}:${PASS}@${HOST}:${PORT}/${DB}`;
      const db = await initDatabase({ url: URL });
      try {
        await db.execute("DROP TABLE IF EXISTS t4_batch_people");
        // InnoDB (mysql:8 default) gives the batch a real transactional rollback.
        await db.execute(
          "CREATE TABLE t4_batch_people (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(255)) ENGINE=InnoDB",
        );
        await batchContract("MySQL", db, "t4_batch_people", "positive");
        await db.execute("DROP TABLE IF EXISTS t4_batch_people");
      } catch (e) {
        assert("MySQL batch insert (no exception)", false, (e as Error).message);
      } finally {
        try { await closeDatabase(); } catch { /* ignore */ }
      }
    }
  }
}

// ── MSSQL (live, gated on reachability + the tedious driver) ─────────
{
  console.log("\n-- MSSQL (live) --");
  const HOST = process.env.TINA4_TEST_MSSQL_HOST ?? "localhost";
  const PORT = parseInt(process.env.TINA4_TEST_MSSQL_PORT ?? "1433", 10);
  const USER = process.env.TINA4_TEST_MSSQL_USERNAME ?? "sa";
  const PASS = process.env.TINA4_TEST_MSSQL_PASSWORD ?? "TinaSQL123!Secure";
  const DB = process.env.TINA4_TEST_MSSQL_DB ?? "tina4_test";

  if (!(await reachable(HOST, PORT))) {
    skip(`mssql not reachable at ${HOST}:${PORT} — skipping`);
  } else {
    let hasDriver = true;
    try {
      await import("tedious");
    } catch {
      hasDriver = false;
      skip("tedious driver not installed — npm install tedious");
    }
    if (hasDriver) {
      const URL = `mssql://${USER}:${encodeURIComponent(PASS)}@${HOST}:${PORT}/${DB}`;
      const db = await initDatabase({ url: URL });
      try {
        await db.execute("IF OBJECT_ID('t4_batch_people', 'U') IS NOT NULL DROP TABLE t4_batch_people");
        await db.execute(
          "CREATE TABLE t4_batch_people (id INT IDENTITY(1,1) PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(255))",
        );
        // The MSSQL batch path surfaces no per-row id (executeManyAsync returns
        // only totalAffected), so lastId is not asserted for the batch.
        await batchContract("MSSQL", db, "t4_batch_people", "none");
        await db.execute("IF OBJECT_ID('t4_batch_people', 'U') IS NOT NULL DROP TABLE t4_batch_people");
      } catch (e) {
        assert("MSSQL batch insert (no exception)", false, (e as Error).message);
      } finally {
        try { await closeDatabase(); } catch { /* ignore */ }
      }
    }
  }
}

try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

summaryAndExit(fail > 0 ? 1 : 0);
