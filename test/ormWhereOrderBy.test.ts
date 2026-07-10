/**
 * Lock-in tests for BaseModel.where(orderBy) — v3.13.66 ORM where-ordering parity.
 *
 * where() was the only filtered finder that could not order its results
 * (find / all / QueryBuilder all could). These tests pin the new behaviour:
 *   * orderBy sorts the filtered result (ASC and DESC)
 *   * omitting orderBy injects NO ORDER BY (rows come back in natural order)
 *
 * orderBy lands as the 6th positional param (matching find/all) and the
 * ORDER BY clause is inserted BEFORE the LIMIT/OFFSET in the built SQL.
 *
 * Mirrors tina4-python/tests/test_orm_where_order_by.py (the Python master).
 * Real SQLite, no mocks, positive + negative. Rows are inserted OUT OF
 * alphabetical order so a missing/extra ORDER BY is observable in the output.
 *
 * Run with: npx tsx test/ormWhereOrderBy.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseModel, initDatabase, closeDatabase } from "../packages/orm/src/index.ts";

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

class WPerson extends BaseModel {
  static tableName = "wpeople";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const },
  };
}

const tmp = mkdtempSync(join(tmpdir(), "tina4-orm-where-order-"));

async function freshDb(file: string) {
  const db = await initDatabase({ url: `sqlite:///${join(tmp, file)}` });
  await db.execute("CREATE TABLE wpeople (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
  // Out of alphabetical order: Charlie(id=1), Alice(id=2), Bob(id=3)
  await db.execute("INSERT INTO wpeople (name) VALUES ('Charlie')");
  await db.execute("INSERT INTO wpeople (name) VALUES ('Alice')");
  await db.execute("INSERT INTO wpeople (name) VALUES ('Bob')");
  return db;
}

const names = (rows: WPerson[]): string[] => rows.map((r) => (r as any).name as string);

async function run() {
  console.log("--- BaseModel.where(orderBy) ---");

  {
    const db = await freshDb("asc.db");
    const rows = await WPerson.where("1=1", [], 20, 0, undefined, "name ASC");
    assert("orderBy 'name ASC' sorts results",
      JSON.stringify(names(rows)) === JSON.stringify(["Alice", "Bob", "Charlie"]),
      `got ${JSON.stringify(names(rows))}`);
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  {
    const db = await freshDb("desc.db");
    // id DESC -> 3, 2, 1 -> Bob, Alice, Charlie
    const rows = await WPerson.where("1=1", [], 20, 0, undefined, "id DESC");
    assert("orderBy 'id DESC' reverses results",
      JSON.stringify(names(rows)) === JSON.stringify(["Bob", "Alice", "Charlie"]),
      `got ${JSON.stringify(names(rows))}`);
    db.close();
    try { await closeDatabase(); } catch { /* ignore */ }
  }

  {
    const db = await freshDb("none.db");
    // negative: no orderBy -> no ORDER BY injected -> natural (insertion) order
    const rows = await WPerson.where("1=1");
    assert("no orderBy leaves rows in natural order (no ORDER BY injected)",
      JSON.stringify(names(rows)) === JSON.stringify(["Charlie", "Alice", "Bob"]),
      `got ${JSON.stringify(names(rows))}`);
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
