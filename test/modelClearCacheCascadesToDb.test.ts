/**
 * Regression: BaseModel.clearCache() must invalidate BOTH cache layers.
 *
 * PY-06-22 (3.13.105) ported to Node. Before the fix, BaseModel.clearCache()
 * cleared only the ORM-layer tag cache (`modelQueryCache`) and left the
 * DB-layer cache alone -- so a caller using it as a manual escape hatch (an
 * out-of-band write, a race with another process, a deliberate refresh) still
 * read stale rows from db.fetch() on the next query.
 *
 * The invariant: after Model.clearCache(), the model's bound DB adapter's
 * cacheStats().size is 0. Named positive AND negative cases; proven a real
 * gate by mutation (revert the cascade -- both fail).
 *
 * NOT a mock: real SQLite via node:sqlite through the framework's own
 * SQLiteAdapter, wrapped by the real CachedDatabaseAdapter that ships with
 * ORM binds. Real cached() round-trip on a real ORM subclass.
 *
 * Run with: npx tsx test/modelClearCacheCascadesToDb.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseModel, bindDatabase, closeDatabase } from "../packages/orm/src/index.ts";
import { SQLiteAdapter } from "../packages/orm/src/adapters/sqlite.ts";
import { CachedDatabaseAdapter } from "../packages/orm/src/index.ts";

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

// PY-06-22 is only reachable with BOTH cache layers opted in.
process.env.TINA4_AUTO_CACHING = "true";
process.env.TINA4_DB_CACHE = "true";
process.env.TINA4_DB_CACHE_BACKEND = "memory";

const sandbox = mkdtempSync(join(tmpdir(), "tina4-clear-cache-cascade-"));

class Widget622 extends BaseModel {
  static tableName = "widgets_622";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true, maxLength: 100 },
  };
  // Expose protected getDb() so the test can assert against the DB layer
  // directly (parity with the Python test's db.cache_stats() assertion).
  static resolveDb(): CachedDatabaseAdapter {
    return (this as any).getDb() as CachedDatabaseAdapter;
  }
}

async function makeDb(fileName: string): Promise<SQLiteAdapter> {
  const path = join(sandbox, fileName);
  const raw = new SQLiteAdapter(path);
  raw.execute(
    "CREATE TABLE widgets_622 " +
      "(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)",
  );
  raw.execute("INSERT INTO widgets_622 (name) VALUES ('one'), ('two')");
  return raw;
}

async function reset(): Promise<void> {
  // Ensure BaseModel picks up the freshly-bound default connection on the
  // next call -- BaseModel caches the model->adapter binding.
  (Widget622 as any)._db = undefined;
  (Widget622 as any)._resolvedDb = undefined;
  closeDatabase();
}

console.log("=== Model.clearCache cascades to DB layer ===\n");

// ── Positive: single DB, clearCache() cascades to db.cacheClear() ─────
await reset();
{
  const rawA = await makeDb("db_a.db");
  bindDatabase(rawA);

  await Widget622.cached("SELECT * FROM widgets_622", [], 60);
  const primed = Widget622.resolveDb().cacheStats().size;
  assert(
    "prime: DB-layer cache populates on cached() read",
    primed > 0,
    `size=${primed}`,
  );

  Widget622.clearCache();

  const afterClear = Widget622.resolveDb().cacheStats().size;
  assert(
    "after clearCache(): DB-layer cache is empty (cascade fired)",
    afterClear === 0,
    `size=${afterClear} -- clearCache() did not cascade to db.cacheClear()`,
  );
}

// ── Negative: unrelated named connection is NOT touched by the cascade ─
await reset();
{
  const rawDefault = await makeDb("default.db");
  const rawOther = await makeDb("other.db");
  bindDatabase(rawDefault);
  bindDatabase(rawOther, "other");

  // Prime the DEFAULT (Widget622's) cache via cached().
  await Widget622.cached("SELECT * FROM widgets_622", [], 60);
  // Prime the OTHER cache via a direct queryAsync (queryAsync caches on the
  // wrapper too -- same code path as Model.cached() uses).
  const otherWrapped = (await import("../packages/orm/src/index.ts")).getNamedAdapter("other") as CachedDatabaseAdapter;
  await (otherWrapped as any).queryAsync("SELECT * FROM widgets_622");

  const primedDefault = Widget622.resolveDb().cacheStats().size;
  const primedOther = otherWrapped.cacheStats().size;
  assert(
    "prime: default DB cache populated",
    primedDefault > 0,
    `size=${primedDefault}`,
  );
  assert(
    "prime: unrelated named DB cache populated",
    primedOther > 0,
    `size=${primedOther}`,
  );

  Widget622.clearCache();

  const afterDefault = Widget622.resolveDb().cacheStats().size;
  const afterOther = otherWrapped.cacheStats().size;
  assert(
    "clearCache() cleared model's own DB cache",
    afterDefault === 0,
    `size=${afterDefault}`,
  );
  assert(
    "clearCache() must NOT touch unrelated named DB cache",
    afterOther > 0,
    `size=${afterOther} -- cascade must be scoped to the model's bound connection`,
  );
}

// ── Cleanup ────────────────────────────────────────────────────────────
await reset();
try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
delete process.env.TINA4_AUTO_CACHING;
delete process.env.TINA4_DB_CACHE;
delete process.env.TINA4_DB_CACHE_BACKEND;

console.log(`\n=== Total: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
