/**
 * toPaginate() with NO arguments describes the page the query returned.
 *
 * REGRESSION, measured 2026-08-05 across all four frameworks on a real 250-row
 * table read with limit=20 offset=40 (page 3 of 13). Node reported page 1 of 2
 * and returned 10 of the 20 rows: it ignored the query entirely, defaulting
 * page to 1 and perPage to 10, then re-sliced rows that were already just that
 * page. A caller who paginated correctly at the SQL level had the answer
 * silently re-paginated underneath them.
 *
 * Pure value object, no dependency and no double.
 */
import { DatabaseResult } from "../packages/orm/src/databaseResult.js";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

// The rows page 3 holds, out of 250.
const rows = Array.from({ length: 20 }, (_, i) => ({ id: 40 + i }));
const pageThree = () => new DatabaseResult(rows, ["id"], 250, 20, 40);

console.log("\ntoPaginate describes the fetched page\n");

const p = pageThree().toPaginate();
assert("page is derived from the offset", p.page === 3, `got ${p.page}`);
assert("per_page comes from the query limit", p.per_page === 20, `got ${p.per_page}`);
assert("total_pages is over the true total", p.total_pages === 13, `got ${p.total_pages}`);
assert("records are the rows the query returned", p.records.length === 20, `got ${p.records.length}`);
assert("records are not re-sliced", (p.records[0] as any)?.id === 40, `got ${(p.records[0] as any)?.id}`);
assert("total is the true total", p.total === 250, `got ${p.total}`);

// NEGATIVE (ADR-0043): toPaginate() takes NO arguments — passing any argument
// RAISES. A DatabaseResult holds no connection, so an argument could only
// re-slice rows already in memory (the measured Ruby zero-rows bug) and lie
// about total_pages. It must throw, not answer wrongly.
let threw = false;
try { (pageThree() as unknown as { toPaginate: (p: number, q: number) => unknown }).toPaginate(2, 10); } catch { threw = true; }
assert("passing an argument to toPaginate() is refused", threw);

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);
