/**
 * ModelCollection — ORM read queries carry the query total (ADR-0064).
 *
 * Real node:sqlite, real ORM reads, no mocks. This is the Node port of the
 * Python reference (tina4-python/tests/test_orm_model_collection.py) for the
 * uniform cross-framework contract: where / select / find (filter form) / all /
 * withTrashed return an Array-compatible collection that ALSO exposes
 * getTotalRecords() and the same seven-key toPaginate() envelope as
 * DatabaseResult. Positive AND negative cases, case-for-case with the master.
 *
 * The total is the fetch COUNT probe the query already runs — never the page
 * length. The mutation proof for that (return page length instead of the probe
 * -> case 1 goes red) is documented in plan/model-collection-adr-0064.md.
 *
 * Run with: npx tsx test/ormModelCollection.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseModel,
  ModelCollection,
  initDatabase,
  closeDatabase,
  type Database,
} from "../packages/orm/src/index.ts";

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

const sameKeys = (a: object, b: object): boolean =>
  JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());

// ── Product model: 250 books + 7 music = 257 rows ──────────────────────────
class PColl extends BaseModel {
  static tableName = "pcoll";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const },
    category: { type: "string" as const },
    price: { type: "number" as const },
  };
}

// ── Note model: soft-delete, 5 rows, one soft-deleted ──────────────────────
class Note extends BaseModel {
  static tableName = "notes";
  static softDelete = true;
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    body: { type: "string" as const },
  };
}

const tmp = mkdtempSync(join(tmpdir(), "tina4-orm-collection-"));

async function seedProducts(): Promise<Database> {
  const db = await initDatabase({ url: `sqlite:///${join(tmp, "products.db")}` });
  await db.execute(
    "CREATE TABLE pcoll (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, category TEXT, price NUMERIC)",
  );
  // Real SQLite writes, wrapped in one transaction for speed. The READ path
  // under test is the real ORM.
  await db.startTransaction();
  for (let i = 0; i < 250; i++) {
    await db.execute("INSERT INTO pcoll (name, category, price) VALUES (?, ?, ?)", [`book${i}`, "books", i]);
  }
  for (let i = 0; i < 7; i++) {
    await db.execute("INSERT INTO pcoll (name, category, price) VALUES (?, ?, ?)", [`song${i}`, "music", i]);
  }
  await db.commit();
  return db;
}

async function seedNotes(): Promise<Database> {
  const db = await initDatabase({ url: `sqlite:///${join(tmp, "notes.db")}` });
  await db.execute(
    "CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, is_deleted INTEGER DEFAULT 0)",
  );
  await db.startTransaction();
  for (let i = 0; i < 5; i++) {
    await db.execute("INSERT INTO notes (body) VALUES (?)", [`n${i}`]);
  }
  await db.commit();
  return db;
}

async function run(): Promise<void> {
  console.log("--- ModelCollection (ADR-0064) ---");

  const db = await seedProducts();

  // ── the core promise: page is capped, total is the whole filtered set ────
  {
    const rows = await PColl.where("category = ?", ["books"], 20, 40);
    assert("where returns a ModelCollection", rows instanceof ModelCollection);
    assert("where result is a real Array (non-breaking)", Array.isArray(rows) === true);
    assert("where page length is capped to limit (20)", rows.length === 20, `got ${rows.length}`);
    assert("where getTotalRecords is the whole matching set (250)",
      rows.getTotalRecords() === 250, `got ${rows.getTotalRecords()}`);
  }

  // ── every returning method carries the total ─────────────────────────────
  {
    const rows = await PColl.all(10);
    assert("all page length capped (10)", rows.length === 10, `got ${rows.length}`);
    assert("all carries table total (257)", rows.getTotalRecords() === 257, `got ${rows.getTotalRecords()}`);
  }
  {
    const rows = await PColl.select("SELECT * FROM pcoll WHERE category = ?", ["music"], 5);
    assert("select page length capped (5)", rows.length === 5, `got ${rows.length}`);
    assert("select carries total (7)", rows.getTotalRecords() === 7, `got ${rows.getTotalRecords()}`);
  }
  {
    const rows = await PColl.find({ category: "books" }, 10);
    assert("find(filter) returns a ModelCollection", rows instanceof ModelCollection);
    assert("find(filter) page length capped (10)", (rows as ModelCollection<PColl>).length === 10);
    assert("find(filter) carries total (250)",
      (rows as ModelCollection<PColl>).getTotalRecords() === 250,
      `got ${(rows as ModelCollection<PColl>).getTotalRecords()}`);
  }

  // ── find(pk) still returns a single model, not a collection ──────────────
  {
    const one = await PColl.find(1);
    assert("find(pk) is not a ModelCollection", !(one instanceof ModelCollection));
    assert("find(pk) is not an Array", Array.isArray(one) === false);
    assert("find(pk) returns the single model", one !== null && (one as PColl).id === 1);
  }

  // ── toPaginate() — the uniform seven-key envelope ────────────────────────
  {
    const rows = await PColl.where("category = ?", ["books"], 20, 40);
    const page = rows.toPaginate();
    assert("toPaginate has exactly the seven keys",
      JSON.stringify(Object.keys(page).sort()) ===
        JSON.stringify(["limit", "offset", "page", "per_page", "records", "total", "total_pages"]),
      `got ${JSON.stringify(Object.keys(page).sort())}`);
    assert("toPaginate total is 250", page.total === 250, `got ${page.total}`);
    assert("toPaginate per_page is 20", page.per_page === 20, `got ${page.per_page}`);
    assert("toPaginate page is 3 (offset 40 / 20 + 1)", page.page === 3, `got ${page.page}`);
    assert("toPaginate total_pages is 13 (ceil 250/20)", page.total_pages === 13, `got ${page.total_pages}`);
    assert("toPaginate limit is 20", page.limit === 20, `got ${page.limit}`);
    assert("toPaginate offset is 40", page.offset === 40, `got ${page.offset}`);
    assert("toPaginate records has the page's 20 rows", page.records.length === 20, `got ${page.records.length}`);

    // Identical to db.fetch(...).toPaginate() for the same query.
    const raw = (await db.fetch("SELECT * FROM pcoll WHERE category = ?", ["books"], 20, 40)).toPaginate();
    assert("toPaginate total == db.fetch total", page.total === raw.total, `${page.total} vs ${raw.total}`);
    assert("toPaginate total_pages == db.fetch total_pages",
      page.total_pages === raw.total_pages, `${page.total_pages} vs ${raw.total_pages}`);
    assert("toPaginate record is a plain object",
      typeof page.records[0] === "object" && page.records[0] !== null && !Array.isArray(page.records[0]));
    assert("toPaginate record keys == db.fetch record keys",
      sameKeys(page.records[0] as object, raw.records[0] as object),
      `${JSON.stringify(Object.keys(page.records[0] as object))} vs ${JSON.stringify(Object.keys(raw.records[0] as object))}`);
  }

  // ── array compatibility (nothing existing breaks + no subclass trap) ─────
  {
    const rows = await PColl.where("category = ?", ["books"], 20, 40); // books 40..59
    // for-of
    let counted = 0;
    for (const _r of rows) counted++;
    assert("for-of iterates the page", counted === 20, `got ${counted}`);
    // index
    assert("index access returns a model instance", rows[0] instanceof PColl);
    assert("indexed model has its column value", (rows[0] as PColl & { category: string }).category === "books");
    // map -> plain Array of transformed values (Symbol.species trap defused)
    const prices = rows.map((r) => (r as PColl & { price: number }).price);
    assert("map returns a plain Array", Array.isArray(prices) && !(prices instanceof ModelCollection));
    assert("map transforms every element (not a length-N empty array)",
      prices.length === 20 && prices[0] === 40 && prices[19] === 59,
      `got len ${prices.length}, first ${prices[0]}, last ${prices[19]}`);
    // filter -> plain Array, real predicate
    const cheap = rows.filter((r) => (r as PColl & { price: number }).price < 45);
    assert("filter returns a plain Array with the matching subset",
      Array.isArray(cheap) && cheap.length === 5, `got ${cheap.length}`);
    // slice -> plain Array
    const head = rows.slice(0, 5);
    assert("slice returns a plain Array of the right length", Array.isArray(head) && head.length === 5);
    // spread
    const spread = [...rows];
    assert("spread yields a plain Array of 20", Array.isArray(spread) && spread.length === 20);
    // length
    assert("length is the page size", rows.length === 20);
    // JSON.stringify -> array of models, no internals leaked
    const json = JSON.parse(JSON.stringify(rows));
    assert("JSON.stringify serialises as the array of models",
      Array.isArray(json) && json.length === 20 && json[0].category === "books");
    assert("JSON.stringify does not leak _total/_limit/_offset",
      !("_total" in json) && !Array.isArray(json[0]) && json[0]._total === undefined);
    // getTotalRecords survives on the collection itself
    assert("getTotalRecords survives on the returned collection", rows.getTotalRecords() === 250);
  }

  // ── edge cases ───────────────────────────────────────────────────────────
  {
    // Offset past the end: no rows on this page, but the total still stands.
    const rows = await PColl.where("category = ?", ["books"], 20, 1000);
    assert("empty page has zero rows", rows.length === 0, `got ${rows.length}`);
    assert("empty page still reports the total (250)", rows.getTotalRecords() === 250, `got ${rows.getTotalRecords()}`);
    assert("empty page toPaginate total is 250", rows.toPaginate().total === 250);
  }
  {
    const rows = await PColl.where("category = ?", ["nothing"]);
    assert("zero matches -> empty page", rows.length === 0);
    assert("zero matches -> total is 0", rows.getTotalRecords() === 0, `got ${rows.getTotalRecords()}`);
  }

  db.close();
  try { await closeDatabase(); } catch { /* ignore */ }

  // ── soft delete: excluded from the live total, included in withTrashed ───
  {
    const ndb = await seedNotes();
    const target = await Note.find(1);
    assert("Note.find(1) is a single model", target !== null && !(target instanceof ModelCollection));
    await (target as Note).delete(); // soft-delete one

    const live = await Note.where("1=1");
    assert("soft-deleted row excluded from live total (4)",
      live.getTotalRecords() === 4, `got ${live.getTotalRecords()}`);
    assert("live page excludes the soft-deleted row", live.length === 4, `got ${live.length}`);

    const trashed = await Note.withTrashed("1=1");
    assert("withTrashed returns a ModelCollection", trashed instanceof ModelCollection);
    assert("soft-deleted row included in withTrashed total (5)",
      trashed.getTotalRecords() === 5, `got ${trashed.getTotalRecords()}`);
    assert("withTrashed page includes the soft-deleted row", trashed.length === 5, `got ${trashed.length}`);

    ndb.close();
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
