/**
 * Write-path contract: a write with no filter is an error, not a full-table operation.
 *
 * Audit feature 4 (plan/v3/features/004-sqlite-adapter.md), P1.
 *
 * Node's failure mode differs from the others. Python, PHP and Ruby build
 * "UPDATE t SET ..." with NO WHERE and overwrite every row. Node builds
 * "UPDATE t SET ... WHERE " with an empty clause, which is invalid SQL, catches
 * the error, and returns { success: false, affectedRows: 0 } -- so a caller who
 * does not inspect the result believes the write landed. Silent either way.
 *
 * Real SQLite files in a temp dir via node:sqlite. No mocks.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../packages/orm/src/database.js";
import { SQLTranslator } from "../packages/orm/src/sqlTranslator.js";

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => unknown): Promise<void> {
  try {
    // MUST await: an async body returns a pending promise, and without the await
    // check() sees no throw and counts a genuine failure as a pass.
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${(e as Error).message}`);
    failed++;
  }
}

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error(message);
}

/**
 * RUN THIS AGAINST EVERY LIVE ENGINE. SQLite alone proves almost nothing here:
 * the whole reason per-adapter write SQL exists is that placeholder style,
 * RETURNING support and identifier quoting differ exactly where the engine
 * differs. Point it at a real engine with:
 *
 *   TINA4_TEST_WRITE_PATH_URL=postgres://host:5432/db \
 *   TINA4_TEST_WRITE_PATH_USERNAME=u TINA4_TEST_WRITE_PATH_PASSWORD=p \
 *     npx tsx test/writePathContract.test.ts
 *
 * Unset, it falls back to a temp SQLite file so the suite still runs anywhere.
 */
const ENGINE_URL = process.env.TINA4_TEST_WRITE_PATH_URL || "";

async function withDb(fn: (db: any) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tina4-writepath-"));
  try {
    const db = ENGINE_URL
      ? await initDatabase({
          url: ENGINE_URL,
          username: process.env.TINA4_TEST_WRITE_PATH_USERNAME ?? "",
          password: process.env.TINA4_TEST_WRITE_PATH_PASSWORD ?? "",
        })
      : await initDatabase({ url: `sqlite://${join(dir, "contract.db")}` });

    try {
      await db.execute("DROP TABLE t");
    } catch {
      /* first run against this engine */
    }

    // AUTOINCREMENT is SQLite's spelling; the translator rewrites it per engine.
    // `id INTEGER PRIMARY KEY` self-increments on SQLite and is a plain NOT NULL
    // column everywhere else - writing it by hand is how a suite silently stays
    // SQLite-only.
    const ddl = "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(80))";
    // The engine comes from the URL: Database.dbType is private, and reading it
    // as `any` silently yielded undefined, so the DDL went out with SQLite's
    // AUTOINCREMENT and PostgreSQL rejected it outright.
    // autoIncrementSyntax keys off the "-ql" spelling for PostgreSQL, so
    // "postgres" alone silently does nothing and the DDL keeps SQLite's
    // AUTOINCREMENT. Ruby's runner normalises the same way.
    const scheme = ENGINE_URL ? (ENGINE_URL.split(":")[0] || "sqlite") : "sqlite";
    const engine = scheme === "postgres" ? "postgresql" : scheme;
    await db.execute(SQLTranslator.autoIncrementSyntax(ddl, engine));

    // Let the SEQUENCE assign the ids. The assertions key on id 1 and 2, and a
    // fresh sequence yields exactly those in insertion order on every engine.
    // Hand-seeding id: 1, 2 instead leaves a real sequence still pointing at 1,
    // so the first insert that omits an id collides on the primary key - SQLite
    // hides that because its rowid follows the max.
    await db.insert("t", { name: "one" });
    await db.insert("t", { name: "two" });
    try {
      await fn(db);
    } finally {
      // A live engine keeps a real socket open, and an unclosed socket pins the
      // Node event loop: the file only ever exited because a FAILING run hit
      // process.exit(1) at the end. An all-green run hung forever with its
      // connections idle - the green path was untestable.
      try { db.close(); } catch { /* already closed */ }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function rows(db: any): Promise<Record<string, unknown>[]> {
  const r = await db.fetch("SELECT * FROM t ORDER BY id");
  return r.records as Record<string, unknown>[];
}

async function main(): Promise<void> {
  console.log("write-path contract");

  // --- pair 1: keyed update ---------------------------------------------

  await check("updates only the row named by the primary key in the data", async () => {
    await withDb(async (db) => {
      await db.update("t", { id: 1, name: "CHANGED" });
      const r = await rows(db);
      assert(r.length === 2, `expected 2 rows, got ${r.length}`);
      assert(r[0].name === "CHANGED", `row 1 not updated: ${JSON.stringify(r[0])}`);
      assert(r[1].name === "two", `row 2 was touched: ${JSON.stringify(r[1])}`);
    });
  });

  await check("negative: an update without a filter or primary key throws", async () => {
    await withDb(async (db) => {
      const before = await rows(db);
      let threw = false;
      try {
        await db.update("t", { name: "NOPK" });
      } catch {
        threw = true;
      }
      assert(threw, "a filterless update did not throw");
      const after = await rows(db);
      assert(
        JSON.stringify(before) === JSON.stringify(after),
        `a filterless update modified rows: ${JSON.stringify(after)}`,
      );
    });
  });

  // --- pair 2: no silent no-op -----------------------------------------

  await check("reports the rows it changed", async () => {
    await withDb(async (db) => {
      const result = await db.update("t", { name: "X" }, { id: 1 });
      assert(result.affectedRows === 1, `expected affectedRows 1, got ${result.affectedRows}`);
    });
  });

  await check("negative: never reports zero affected when a matching row exists", async () => {
    await withDb(async (db) => {
      const result = await db.update("t", { id: 2, name: "TWO" });
      assert(
        result.affectedRows !== 0,
        "update reported zero affected rows while a matching row existed - " +
          "a caller who does not check affectedRows believes the write landed",
      );
    });
  });

  // --- pair 3: filter forms -------------------------------------------

  await check("accepts an object filter on delete", async () => {
    await withDb(async (db) => {
      await db.delete("t", { id: 2 });
      const r = await rows(db);
      assert(r.length === 1 && r[0].id === 1, `unexpected rows: ${JSON.stringify(r)}`);
    });
  });

  // --- pair 4: no accidental truncate ---------------------------------

  await check("truncate removes every row", async () => {
    await withDb(async (db) => {
      await db.truncate("t");
      const r = await rows(db);
      assert(r.length === 0, `truncate left rows: ${JSON.stringify(r)}`);
    });
  });

  await check("negative: a delete without a filter throws", async () => {
    await withDb(async (db) => {
      const before = await rows(db);
      let threw = false;
      try {
        await db.delete("t");
      } catch {
        threw = true;
      }
      assert(threw, "a filterless delete did not throw");
      const after = await rows(db);
      assert(
        JSON.stringify(before) === JSON.stringify(after),
        "a filterless delete removed rows",
      );
    });
  });

  // --- pair 5: write result contract ----------------------------------

  await check("insert reports a lastId", async () => {
    await withDb(async (db) => {
      const result = await db.insert("t", { name: "three" });
      assert(result.lastId !== undefined && result.lastId !== null, "insert reported no lastId");
    });
  });

  await check("negative: update and delete do not report a lastId", async () => {
    await withDb(async (db) => {
      const u = await db.update("t", { id: 1, name: "CHANGED" });
      assert(u.lastId === undefined || u.lastId === null, `update reported a lastId: ${u.lastId}`);
      const d = await db.delete("t", { id: 2 });
      assert(d.lastId === undefined || d.lastId === null, `delete reported a lastId: ${d.lastId}`);
    });
  });

  // --- primary-key introspection --------------------------------------

  await check("introspects the primary key rather than assuming id", async () => {
    await withDb(async (db) => {
      const pk = await db.primaryKey("t");
      assert(JSON.stringify(pk) === '["id"]', `expected primary key ["id"], got ${JSON.stringify(pk)}`);
    });
  });

  // --- composite primary keys -----------------------------------------
  // A PK resolver returning only the FIRST key column reintroduces the whole
  // data-loss bug for composite-key tables: WHERE order_id = 1 matches every
  // row in that order.

  async function withComposite(fn: (db: any) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "tina4-composite-"));
    try {
      const db = await initDatabase({ url: `sqlite://${join(dir, "composite.db")}` });
      await db.execute(
        "CREATE TABLE order_items (order_id INTEGER, product_id INTEGER, qty INTEGER," +
          " PRIMARY KEY (order_id, product_id))",
      );
      await db.insert("order_items", { order_id: 1, product_id: 5, qty: 1 });
      await db.insert("order_items", { order_id: 1, product_id: 6, qty: 2 });
      await db.insert("order_items", { order_id: 2, product_id: 5, qty: 3 });
      try {
        await fn(db);
      } finally {
        try { db.close(); } catch { /* already closed */ }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const items = async (db: any) =>
    (await db.fetch("SELECT * FROM order_items ORDER BY order_id, product_id")).records;

  await check("composite: returns every key column", async () => {
    await withComposite(async (db) => {
      const pk = await db.primaryKey("order_items");
      assert(
        JSON.stringify(pk) === '["order_id","product_id"]',
        `expected both key columns, got ${JSON.stringify(pk)}`,
      );
    });
  });

  await check("composite negative: never returns only the first key column", async () => {
    await withComposite(async (db) => {
      const pk = await db.primaryKey("order_items");
      assert(pk.length === 2, `a composite key collapsed to ${JSON.stringify(pk)}`);
    });
  });

  await check("composite: a keyed update touches exactly one row", async () => {
    await withComposite(async (db) => {
      await db.update("order_items", { order_id: 1, product_id: 5, qty: 99 });
      const r = await items(db);
      assert(r[0].qty === 99, `target row not updated: ${JSON.stringify(r[0])}`);
      assert(r[1].qty === 2, `sibling row was touched: ${JSON.stringify(r[1])}`);
      assert(r[2].qty === 3, `other order was touched: ${JSON.stringify(r[2])}`);
    });
  });

  await check("composite negative: a partial key throws rather than matching many", async () => {
    await withComposite(async (db) => {
      const before = JSON.stringify(await items(db));
      let threw = false;
      try {
        await db.update("order_items", { order_id: 1, qty: 42 });
      } catch {
        threw = true;
      }
      assert(threw, "a partial composite key did not throw");
      assert(
        JSON.stringify(await items(db)) === before,
        "a partial composite key modified rows - it matched on the first column",
      );
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// Self-executing: a test file that only DEFINES tests reports a passing
// "0 passed" and hides everything.
await main();
