/**
 * Lock-in: QueryBuilder.get() returns a DatabaseResult, not a bare array.
 *
 * The last of three recorded ORM parity gaps. All three other frameworks return
 * the DatabaseResult that db.fetch() produces:
 *   Python  get() -> DatabaseResult   (orm/query_builder/__init__.py:201)
 *   PHP     get(): mixed -> $this->db->fetch(...)   (QueryBuilder.php:233)
 *   Ruby    get -> @db.fetch(...)                   (query_builder.rb:167)
 * Node returned a plain array, so the same builder chain produced a different
 * TYPE per language and portable code could not read .records/.count/.limit.
 *
 * A bare array would satisfy several of these assertions by accident (an array
 * is iterable and spreadable), so the shape checks below are the ones that
 * matter: `.records` must be an array, and the result itself must NOT be one.
 *
 * NO MOCKS — real SQLite via node:sqlite.
 */
import { initDatabase, getAdapter } from "../packages/orm/src/database.ts";
import { QueryBuilder } from "../packages/orm/src/queryBuilder.ts";
import { DatabaseResult } from "../packages/orm/src/databaseResult.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;

function assert(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

console.log("=== QueryBuilder.get() result shape (parity) ===\n");

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tina4-qbshape-"));
  try {
    const db = await initDatabase({ url: `sqlite:///${join(dir, "t.db")}` });
    await db.execute(`CREATE TABLE qb_shape (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)`);
    for (const l of ["a", "b", "c"]) {
      await db.execute(`INSERT INTO qb_shape (label) VALUES (?)`, [l]);
    }

    const result = await QueryBuilder.fromTable("qb_shape", getAdapter()).get();

    // THE TRIPWIRE. A bare array passes the iterable checks below by accident;
    // these two cannot pass unless get() returns the wrapper.
    assert("get() returns a DatabaseResult instance", result instanceof DatabaseResult,
      `got ${(result as any)?.constructor?.name}`);
    assert("get() does NOT return a bare array", !Array.isArray(result));

    assert(".records is the rows array", Array.isArray(result.records) && result.records.length === 3,
      `got ${JSON.stringify(result.records?.length)}`);
    assert(".count reports the row count", result.count === 3, `got ${result.count}`);
    assert(".columns is populated from the rows",
      Array.isArray(result.columns) && result.columns.includes("label"),
      `got ${JSON.stringify(result.columns)}`);

    // Iterability is part of the contract — for..of and spread must keep working
    // so the migration from a bare array stays cheap.
    const spread = [...result];
    assert("result is iterable (spread)", spread.length === 3, `got ${spread.length}`);
    let counted = 0;
    for (const _row of result) counted++;
    assert("result is iterable (for..of)", counted === 3, `got ${counted}`);

    // limit/offset ride along on the result, as they do from db.fetch().
    // offset is the SECOND argument to limit() — there is no .offset() method.
    const paged = await QueryBuilder.fromTable("qb_shape", getAdapter()).limit(2, 1).get();
    assert(".limit / .offset are carried on the result",
      paged.limit === 2 && paged.offset === 1,
      `got limit=${paged.limit} offset=${paged.offset}`);
    assert("an explicit limit still truncates the records", paged.records.length === 2,
      `got ${paged.records.length}`);

    // No .limit() call must still mean no cap (v3.13.39) — unchanged by this.
    assert("no .limit() means no silent cap", result.records.length === 3);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

await main();
