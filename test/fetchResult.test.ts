/**
 * Unit tests for FetchResult and toPaginate().
 * Run with: npx tsx test/fetchResult.test.ts
 */
import { FetchResult } from "../packages/orm/src/index.ts";

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

console.log("=== FetchResult Tests ===\n");

// Create test data — 50 rows
const rows = Array.from({ length: 50 }, (_, i) => ({
  id: i + 1,
  name: `User ${i + 1}`,
}));

const result = new FetchResult(rows, "SELECT * FROM users");

// --- Basic properties ---
console.log("--- Basic Properties ---");
assert("count equals row count", result.count === 50);
assert("sql is stored", result.sql === "SELECT * FROM users");
assert("records are stored", result.records.length === 50);

// --- first() / last() ---
console.log("\n--- first() / last() ---");
assert("first() returns first record", result.first()?.id === 1);
assert("last() returns last record", result.last()?.id === 50);

const empty = new FetchResult([]);
assert("first() returns null for empty", empty.first() === null);
assert("last() returns null for empty", empty.last() === null);

// --- isEmpty() ---
console.log("\n--- isEmpty() ---");
assert("isEmpty() false for populated", result.isEmpty() === false);
assert("isEmpty() true for empty", empty.isEmpty() === true);

// --- toArray() ---
console.log("\n--- toArray() ---");
const arr = result.toArray();
assert("toArray() returns array", Array.isArray(arr));
assert("toArray() returns copy", arr !== result.records);
assert("toArray() same length", arr.length === 50);

// --- toJSON() ---
console.log("\n--- toJSON() ---");
const json = result.toJSON();
const parsed = JSON.parse(json);
assert("toJSON() returns valid JSON", Array.isArray(parsed));
assert("toJSON() correct length", parsed.length === 50);

// --- toPaginate() ---
console.log("\n--- toPaginate() ---");

// Default pagination (page 1, perPage 20)
const page1 = result.toPaginate();
assert("default page is 1", page1.page === 1);
assert("default perPage is 20", page1.perPage === 20);
assert("default data length is 20", page1.data.length === 20);
assert("total is 50", page1.total === 50);
assert("totalPages is 3", page1.totalPages === 3);
assert("hasNext is true for page 1", page1.hasNext === true);
assert("hasPrev is false for page 1", page1.hasPrev === false);
assert("first record is id=1", page1.data[0].id === 1);
assert("last record is id=20", page1.data[19].id === 20);

// Page 2
const page2 = result.toPaginate(2, 20);
assert("page 2 data length is 20", page2.data.length === 20);
assert("page 2 first record is id=21", page2.data[0].id === 21);
assert("page 2 hasNext is true", page2.hasNext === true);
assert("page 2 hasPrev is true", page2.hasPrev === true);

// Page 3 (last page, partial)
const page3 = result.toPaginate(3, 20);
assert("page 3 data length is 10", page3.data.length === 10);
assert("page 3 first record is id=41", page3.data[0].id === 41);
assert("page 3 hasNext is false", page3.hasNext === false);
assert("page 3 hasPrev is true", page3.hasPrev === true);

// Custom perPage
const custom = result.toPaginate(1, 10);
assert("custom perPage 10 data length", custom.data.length === 10);
assert("custom perPage 10 totalPages is 5", custom.totalPages === 5);

// Beyond last page
const beyond = result.toPaginate(10, 20);
assert("beyond last page returns empty data", beyond.data.length === 0);
assert("beyond last page hasNext is false", beyond.hasNext === false);
assert("beyond last page hasPrev is true", beyond.hasPrev === true);

// Empty result pagination
const emptyPage = empty.toPaginate();
assert("empty pagination data is empty", emptyPage.data.length === 0);
assert("empty pagination total is 0", emptyPage.total === 0);
assert("empty pagination totalPages is 1", emptyPage.totalPages === 1);
assert("empty pagination hasNext is false", emptyPage.hasNext === false);
assert("empty pagination hasPrev is false", emptyPage.hasPrev === false);

// --- Iterator ---
console.log("\n--- Iterator ---");
let iterCount = 0;
for (const _row of result) {
  iterCount++;
}
assert("iterator visits all records", iterCount === 50);

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
