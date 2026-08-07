/**
 * Pagination contract suite — Feature 18, ADR-0043.
 *
 * Gates the five invariants of pagination_contract.json against the REAL read
 * path: a real node:sqlite temp database, a 250-row table, and db.fetch() so
 * `count` comes from the framework's COUNT probe, not a hand-set constructor arg.
 * The measured query is limit=20 offset=40 (page 3 of 13) — the exact query the
 * 2026-08-05 audit used to catch Node reporting total=20, page=1, per_page=10 and
 * 10 of 20 rows.
 *
 * The envelope is EXACTLY seven snake_case keys, identical across all four
 * frameworks: records, total, page, per_page, total_pages, limit, offset.
 *
 * NO MOCKS — a real node:sqlite database on a real temp file.
 *
 * Run with: npx tsx test/paginationContract.test.ts
 */
import { Database } from "../packages/orm/src/index.js";
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

console.log("=== Pagination contract (Feature 18, ADR-0043) ===\n");

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tina4-paginate-"));
  const db = await Database.create(`sqlite:///${join(dir, "p.db")}`);
  try {
    await db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    for (let i = 1; i <= 250; i++) {
      await db.insert("items", { id: i, name: `n${i}` });
    }

    // Page 3 of 13 — the audit's exact query. records are id 41..60 of 250.
    const pageThree = await db.fetch("SELECT * FROM items ORDER BY id", [], 20, 40);
    // A whole-set read (records.length === count) — used to prove that passing an
    // argument raises even when the rows are all in memory (the old code only
    // refused an argument on a PARTIAL result, so a whole result silently sliced).
    const whole = await db.fetch("SELECT * FROM items ORDER BY id", [], 300, 0);

    // 1. paginate-takes-no-arguments — passing any argument RAISES.
    let threw = false;
    try {
      (whole as unknown as { toPaginate: (p: number) => unknown }).toPaginate(1);
    } catch {
      threw = true;
    }
    assert(
      "paginate-takes-no-arguments: passing an argument to toPaginate() throws",
      threw,
      "toPaginate(1) on a whole result did not throw",
    );

    const env = pageThree.toPaginate();

    // 2. paginate-page-is-derived-from-the-offset — floor(40/20)+1 = 3.
    assert(
      "paginate-page-is-derived-from-the-offset: limit 20 offset 40 -> page 3",
      env.page === 3,
      `got page=${env.page}`,
    );

    // 3. paginate-total-is-the-true-total — the COUNT probe, never rows returned.
    assert(
      "paginate-total-is-the-true-total: 250 rows, a 20-row page -> total 250",
      env.total === 250,
      `got total=${env.total} (rows returned was ${pageThree.records.length})`,
    );

    // 4. paginate-records-are-the-rows-the-query-returned — verbatim, never re-sliced.
    const ids = env.records.map((r) => (r as { id: number }).id);
    assert(
      "paginate-records-are-the-rows-the-query-returned: all 20 rows, id 41..60, unsliced",
      env.records.length === 20 && ids[0] === 41 && ids[19] === 60,
      `got ${env.records.length} rows, first=${ids[0]} last=${ids[19]}`,
    );

    // 5. paginate-key-set-is-identical-in-all-four — EXACTLY these seven snake_case keys.
    const expected = ["limit", "offset", "page", "per_page", "records", "total", "total_pages"];
    const actual = Object.keys(env).sort();
    assert(
      "paginate-key-set-is-identical-in-all-four: exactly {records,total,page,per_page,total_pages,limit,offset}",
      actual.length === expected.length && actual.every((k, i) => k === expected[i]),
      `got keys [${actual.join(", ")}]`,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

await main();
