/**
 * ORM result caching contract -- feature 25 (CACHE-DEC-01).
 * Run with: npx tsx test/ormCacheContract.test.ts
 *
 * Shared conformance fixture:
 *   tina4-documentation/plan/v3/fixtures/ormcache_contract.json
 *
 * Proves, against a REAL SQLite database with REAL rows and REAL ORM writes (NO
 * mocks), that BaseModel.cached():
 *
 *   * caches within the TTL (a DIRECT db write between two reads is NOT seen),
 *     and ttl<=0 means NO-CACHE (every read hits the DB);
 *   * is busted by a save/delete/forceDelete/restore THROUGH THE ORM;
 *   * is tagged by every table it touches, so a write to a JOINed table busts it
 *     while a write to an UNRELATED table leaves it intact.
 *
 * "It cached" is proven POSITIVELY: the ONLY way the second within-TTL read can
 * be stale is that it came from the cache. The direct write is a raw
 * `adapter.execute("UPDATE ...")` on the SAME connection the models use, which
 * never touches the model query cache.
 */
import { rmSync, mkdirSync } from "node:fs";
import { initDatabase, closeDatabase, getAdapter, BaseModel } from "../packages/orm/src/index.ts";
import type { FieldDefinition } from "../packages/orm/src/index.ts";

const TEST_DIR = "/tmp/tina4-ormcache-test";
const TEST_DB = `${TEST_DIR}/ormcache.db`;

let pass = 0;
let fail = 0;
function assertEqual(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} -- expected ${e}, got ${a}`);
    fail++;
  }
}

class CacheAuthor extends BaseModel {
  static tableName = "cacheauthor";
  static fields: Record<string, FieldDefinition> = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
  };
}

class CacheBook extends BaseModel {
  static tableName = "cachebook";
  static softDelete = true;
  static fields: Record<string, FieldDefinition> = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "string" },
    author_id: { type: "integer" },
    is_deleted: { type: "integer", default: 0 },
  };
}

const BOOK_SQL = "SELECT id, title FROM cachebook WHERE is_deleted = 0";
const ALL_BOOK_SQL = "SELECT id, title FROM cachebook";
// A JOIN that touches BOTH tables and filters on the author's name, so a rename
// of the author changes the RESULT SET (row count).
const JOIN_SQL =
  "SELECT b.id FROM cachebook b JOIN cacheauthor a ON a.id = b.author_id WHERE a.name = ?";

try { rmSync(TEST_DIR, { recursive: true }); } catch { /* fresh slate */ }
mkdirSync(TEST_DIR, { recursive: true });

await initDatabase({ type: "sqlite", path: TEST_DB });
const adapter = getAdapter()!;

/** Fresh tables + cleared model cache before each case (single-process script). */
function reset(): void {
  adapter.execute("DROP TABLE IF EXISTS cachebook");
  adapter.execute("DROP TABLE IF EXISTS cacheauthor");
  adapter.execute("CREATE TABLE cacheauthor (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
  adapter.execute(
    "CREATE TABLE cachebook (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, author_id INTEGER, is_deleted INTEGER DEFAULT 0)",
  );
  CacheBook.clearCache();
  CacheAuthor.clearCache();
}

async function newBook(title: string, authorId: number): Promise<void> {
  await new CacheBook({ title, author_id: authorId }).save();
}

console.log("=== ORM result caching contract (feature 25) ===\n");

// ── caches within ttl; ttl=0 = no-cache ─────────────────────────────────────

{
  reset();
  await newBook("A", 0);
  const first = await CacheBook.cached(BOOK_SQL, [], 60);
  // Direct db write behind the cache's back (NOT an ORM write -> no bust).
  adapter.execute("UPDATE cachebook SET title = 'CHANGED' WHERE id = 1");
  const second = await CacheBook.cached(BOOK_SQL, [], 60);
  // Stale on purpose: the only way this is "A" is that it came from cache.
  assertEqual("a cached query is served from cache within ttl",
    [first.map((b) => b.title), second.map((b) => b.title)], [["A"], ["A"]]);
}

{
  reset();
  await newBook("A", 0);
  const first = await CacheBook.cached(BOOK_SQL, [], 0);
  adapter.execute("UPDATE cachebook SET title = 'CHANGED' WHERE id = 1");
  const second = await CacheBook.cached(BOOK_SQL, [], 0);
  // ttl<=0 stores nothing, so this read hit the DB and sees the change.
  assertEqual("ttl zero does not cache",
    [first.map((b) => b.title), second.map((b) => b.title)], [["A"], ["CHANGED"]]);
}

// ── busts on every ORM write ─────────────────────────────────────────────────

{
  reset();
  await newBook("A", 0);
  const before = await CacheBook.cached(BOOK_SQL, [], 60);
  const book = await CacheBook.selectOne("SELECT * FROM cachebook WHERE id = 1");
  book!.title = "B";
  await book!.save();
  const after = await CacheBook.cached(BOOK_SQL, [], 60);
  assertEqual("a save through the orm busts the cached read",
    [before.map((b) => b.title), after.map((b) => b.title)], [["A"], ["B"]]);
}

{
  reset();
  await newBook("A", 0);
  await newBook("B", 0);
  const before = await CacheBook.cached(BOOK_SQL, [], 60);
  await (await CacheBook.selectOne("SELECT * FROM cachebook WHERE id = 1"))!.delete(); // soft
  const after = await CacheBook.cached(BOOK_SQL, [], 60);
  assertEqual("a delete through the orm busts the cached read",
    [before.length, after.length], [2, 1]);
}

{
  reset();
  await newBook("A", 0);
  await newBook("B", 0);
  const before = await CacheBook.cached(ALL_BOOK_SQL, [], 60);
  await (await CacheBook.selectOne("SELECT * FROM cachebook WHERE id = 1"))!.forceDelete();
  const after = await CacheBook.cached(ALL_BOOK_SQL, [], 60);
  assertEqual("a force delete through the orm busts the cached read",
    [before.length, after.length], [2, 1]);
}

{
  reset();
  await newBook("A", 0);
  const book = await CacheBook.selectOne("SELECT * FROM cachebook WHERE id = 1");
  await book!.delete(); // soft-delete -> is_deleted = 1
  const before = await CacheBook.cached(BOOK_SQL, [], 60); // active rows -> empty
  await book!.restore(); // ORM write -> must bust
  const after = await CacheBook.cached(BOOK_SQL, [], 60);
  assertEqual("a restore through the orm busts the cached read",
    [before.length, after.map((b) => b.title)], [0, ["A"]]);
}

// ── tagged by table (cross-table bust; unrelated left intact) ────────────────

{
  reset();
  await new CacheAuthor({ name: "A1" }).save();
  await newBook("A", 1);
  const before = await CacheBook.cached(JOIN_SQL, ["A1"], 60);
  const author = await CacheAuthor.selectOne("SELECT * FROM cacheauthor WHERE id = 1");
  author!.name = "A2";
  await author!.save(); // writes cacheauthor -> must bust the cross-table cached JOIN
  const after = await CacheBook.cached(JOIN_SQL, ["A1"], 60);
  assertEqual("a write to a joined table busts the cross table cached read",
    [before.length, after.length], [1, 0]);
}

{
  reset();
  await new CacheAuthor({ name: "A1" }).save();
  await newBook("A", 1);
  const before = await CacheBook.cached(BOOK_SQL, [], 60);
  // Change the book row directly (no ORM bust), then write an UNRELATED table.
  adapter.execute("UPDATE cachebook SET title = 'RAW' WHERE id = 1");
  const author = await CacheAuthor.selectOne("SELECT * FROM cacheauthor WHERE id = 1");
  author!.name = "A2";
  await author!.save(); // writes cacheauthor only -> must NOT bust the cachebook query
  const after = await CacheBook.cached(BOOK_SQL, [], 60);
  // Survived the unrelated write (tag-scoped bust, not a wholesale flush).
  assertEqual("a write to an unrelated table leaves the cached read intact",
    [before.map((b) => b.title), after.map((b) => b.title)], [["A"], ["A"]]);
}

closeDatabase();
try { rmSync(TEST_DIR, { recursive: true }); } catch { /* best effort */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
