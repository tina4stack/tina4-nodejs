/**
 * Lock-in regression tests for the SEEDING FULL OVERHAUL (P1-P4).
 *
 * Engine-agnostic SQLite (:memory:), no server. These guard the unified
 * visible-but-resilient behaviour: never silent (PHP/Ruby's old bug),
 * never fragile (Python/Node's old crash now that adapterExecute() raises).
 *
 * Mirrors the Python master tests/test_seeder_overhaul.py exactly.
 *
 * Run with: npx tsx test/seederOverhaul.test.ts
 */
import {
  seedTable, seedOrm, seedModels, FakeData, BaseModel, bindDatabase,
} from "../packages/orm/src/index.ts";
import { SQLiteAdapter } from "../packages/orm/src/adapters/sqlite.ts";

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

async function expectThrows(name: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(name, threw);
}

console.log("=== Seeder Overhaul (P1-P4) Lock-in Tests ===\n");

// Helper — fresh in-memory db with a UNIQUE constraint so duplicate rows fail.
function dbWithUnique(): SQLiteAdapter {
  const db = new SQLiteAdapter(":memory:");
  db.execute("CREATE TABLE u (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)");
  return db;
}

// ── P1: error handling (visible but resilient) ──────────────────────────
console.log("--- P1: error handling ---");

{
  // test_summary_shape
  const db = new SQLiteAdapter(":memory:");
  db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
  const fake = new FakeData(1);
  const summary = await seedTable(db, "t", 3, { name: () => fake.name() });
  assert("summary.seeded === 3", summary.seeded === 3, JSON.stringify(summary));
  assert("summary.failed === 0", summary.failed === 0);
  assert("summary.errors is empty array", Array.isArray(summary.errors) && summary.errors.length === 0);
  db.close();
}

{
  // test_constraint_violation_does_not_crash_and_is_not_silent
  const db = dbWithUnique();
  // Every row generates the SAME name → first inserts, rest violate UNIQUE.
  const summary = await seedTable(db, "u", 5, { name: () => "dup" });
  assert("failed >= 1 (NOT silently all-success)", summary.failed >= 1, JSON.stringify(summary));
  assert("seeded === 1 (only first landed)", summary.seeded === 1, JSON.stringify(summary));
  assert("seeded + failed === 5", summary.seeded + summary.failed === 5);
  assert("errors.length === failed", summary.errors.length === summary.failed);
  assert(
    "errors[0] has row + message",
    typeof summary.errors[0]?.row === "number" && typeof summary.errors[0]?.message === "string",
  );
  // And it did NOT raise — the table has exactly one row.
  const rows = db.fetch("SELECT * FROM u");
  assert("only 1 row persisted", rows.length === 1);
  db.close();
}

{
  // test_strict_reraises_on_first_failure
  const db = dbWithUnique();
  await expectThrows("strict=true re-raises on first failure", async () => {
    await seedTable(db, "u", 5, { name: () => "dup" }, undefined, { strict: true });
  });
  db.close();
}

{
  // test_partial_success_counts
  const db = dbWithUnique();
  const names = ["a", "b", "a", "c", "a"];
  let idx = 0;
  const summary = await seedTable(db, "u", 5, { name: () => names[idx++] });
  // a, b inserted; a fails; c inserted; a fails → seeded 3, failed 2
  assert("partial: seeded === 3", summary.seeded === 3, JSON.stringify(summary));
  assert("partial: failed === 2", summary.failed === 2, JSON.stringify(summary));
  db.close();
}

// ── P2: idempotency (clear/truncate) ────────────────────────────────────
console.log("\n--- P2: idempotency ---");

{
  // test_clear_avoids_duplicates_on_rerun
  const db = new SQLiteAdapter(":memory:");
  db.execute("CREATE TABLE c (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
  const fm = { name: () => new FakeData(7).name() };
  await seedTable(db, "c", 10, fm, undefined, { clear: true });
  const first = db.fetch("SELECT * FROM c").length;
  await seedTable(db, "c", 10, fm, undefined, { clear: true });
  const second = db.fetch("SELECT * FROM c").length;
  assert("first run inserts 10", first === 10, `first=${first}`);
  assert("second run still 10 (clear truncated, not 20)", second === 10, `second=${second}`);
  db.close();
}

{
  // test_clear_prevents_unique_pk_violation
  const db = new SQLiteAdapter(":memory:");
  db.execute("CREATE TABLE k (id INTEGER PRIMARY KEY, label TEXT)");
  // Static PK would collide on a naive re-run; clear=true makes it safe.
  let ids = 0;
  const genId = () => ++ids;
  await seedTable(db, "k", 5, { id: genId, label: () => "x" }, undefined, { clear: true });
  ids = 0;
  const summary = await seedTable(db, "k", 5, { id: genId, label: () => "x" }, undefined, { clear: true });
  assert("clear prevents PK collision: failed === 0", summary.failed === 0, JSON.stringify(summary));
  assert("table has exactly 5 rows", db.fetch("SELECT * FROM k").length === 5);
  db.close();
}

// ── P3: reproducibility (seeded RNG) ────────────────────────────────────
console.log("\n--- P3: reproducibility ---");

{
  // test_same_seed_identical_data — determinism comes from the caller's
  // seeded FakeData passed through fieldMap (documented in the seedTable docstring).
  async function runOnce(): Promise<Array<[unknown, unknown]>> {
    const db = new SQLiteAdapter(":memory:");
    db.execute("CREATE TABLE r (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT)");
    const fake = new FakeData(999);
    await seedTable(db, "r", 8, { name: () => fake.name(), email: () => fake.email() });
    const rows = db.fetch<{ name: unknown; email: unknown }>("SELECT * FROM r ORDER BY id");
    db.close();
    return rows.map((row) => [row.name, row.email]);
  }
  const a = await runOnce();
  const b = await runOnce();
  assert("seedTable: same seed → identical data", JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  assert("seedTable: 8 rows generated", a.length === 8);
}

{
  // test_seed_orm_seed_param_reproducible
  async function runOrm(): Promise<Array<[unknown, unknown]>> {
    const db = new SQLiteAdapter(":memory:");
    db.execute("CREATE TABLE seedperson (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT)");
    class SeedPerson extends BaseModel {
      static tableName = "seedperson";
      static fields = {
        id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
        name: { type: "string" as const },
        email: { type: "string" as const },
      };
      static getDb() { return db; }
    }
    await seedOrm(SeedPerson as any, 6, undefined, 4242);
    const rows = db.fetch<{ name: unknown; email: unknown }>("SELECT * FROM seedperson ORDER BY id");
    db.close();
    return rows.map((row) => [row.name, row.email]);
  }
  const a = await runOrm();
  const b = await runOrm();
  assert("seedOrm: same seed param → identical data", JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  assert("seedOrm: 6 rows generated", a.length === 6);
}

// ── P4a: FK ordering (topological sort over the foreignKey graph) ───────
console.log("\n--- P4a: FK ordering ---");

{
  // test_wrong_declared_order_still_seeds_parents_first
  const db = new SQLiteAdapter(":memory:");
  bindDatabase(db);
  db.execute("CREATE TABLE author (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
  db.execute(
    "CREATE TABLE book (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, " +
    "author_id INTEGER NOT NULL REFERENCES author(id))",
  );

  class Author extends BaseModel {
    static tableName = "author";
    static fields = {
      id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
      name: { type: "string" as const },
    };
    static getDb() { return db; }
  }
  class Book extends BaseModel {
    static tableName = "book";
    static fields = {
      id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
      title: { type: "string" as const },
      author_id: { type: "foreignKey" as const, references: "Author" },
    };
    static getDb() { return db; }
  }
  // Names must match the FK `references: "Author"` string for topo-resolution.
  Object.defineProperty(Author, "name", { value: "Author" });
  Object.defineProperty(Book, "name", { value: "Book" });
  BaseModel.registerModel("Author", Author as any);
  BaseModel.registerModel("Book", Book as any);

  // Pass children BEFORE parents on purpose — topo-sort must fix it.
  const results = await seedModels([Book as any, Author as any], 4);

  assert("Author seeded 4, 0 failed", results["Author"].seeded === 4 && results["Author"].failed === 0, JSON.stringify(results["Author"]));
  assert("Book seeded 4, 0 failed (no FK violation)", results["Book"].seeded === 4 && results["Book"].failed === 0, JSON.stringify(results["Book"]));
  assert("author table has 4 rows", db.fetch("SELECT * FROM author").length === 4);
  assert("book table has 4 rows", db.fetch("SELECT * FROM book").length === 4);
  // Every book points at an existing author.
  const orphans = db.fetch("SELECT * FROM book WHERE author_id NOT IN (SELECT id FROM author)");
  assert("no orphan books (every FK resolves to a real parent)", orphans.length === 0, `orphans=${orphans.length}`);
  db.close();
  BaseModel._modelRegistry = {};
}

{
  // test_clear_runs_in_reverse_topo_order
  const db = new SQLiteAdapter(":memory:");
  bindDatabase(db);
  db.execute("CREATE TABLE maker (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
  db.execute(
    "CREATE TABLE widget (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, " +
    "maker_id INTEGER NOT NULL REFERENCES maker(id))",
  );

  class Maker extends BaseModel {
    static tableName = "maker";
    static fields = {
      id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
      name: { type: "string" as const },
    };
    static getDb() { return db; }
  }
  class Widget extends BaseModel {
    static tableName = "widget";
    static fields = {
      id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
      label: { type: "string" as const },
      maker_id: { type: "foreignKey" as const, references: "Maker" },
    };
    static getDb() { return db; }
  }
  Object.defineProperty(Maker, "name", { value: "Maker" });
  Object.defineProperty(Widget, "name", { value: "Widget" });
  BaseModel.registerModel("Maker", Maker as any);
  BaseModel.registerModel("Widget", Widget as any);

  await seedModels([Maker as any, Widget as any], 3);
  // Re-run with clear=true — clearing parents before children would trip the
  // FK; reverse-topo clear (children first) must keep it clean.
  const results = await seedModels([Maker as any, Widget as any], 3, { clear: true });
  assert("Maker re-seed: 0 failed", results["Maker"].failed === 0, JSON.stringify(results["Maker"]));
  assert("Widget re-seed: 0 failed", results["Widget"].failed === 0, JSON.stringify(results["Widget"]));
  assert("maker table has 3 rows after clear+reseed", db.fetch("SELECT * FROM maker").length === 3);
  assert("widget table has 3 rows after clear+reseed", db.fetch("SELECT * FROM widget").length === 3);
  db.close();
  BaseModel._modelRegistry = {};
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
