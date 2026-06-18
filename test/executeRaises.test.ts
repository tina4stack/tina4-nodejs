/**
 * Database.execute() must FAIL LOUD — throw on a SQL error, never silently
 * return false.
 *
 * Pre-3.13.x `Database.execute()` caught the driver exception and returned
 * `false` (storing the cause on `lastError`). Almost no caller checks a
 * boolean after every write, so a failed INSERT/UPDATE/DELETE looked like
 * success while the row never landed — a silent partial-write footgun. It now
 * THROWS (mirroring `fetch()`/`fetchOne()`, which already raise), while still
 * capturing the cause on `lastError` / `getError()`.
 *
 * Engine-agnostic — runs on the built-in node:sqlite adapter, so it executes
 * locally and in CI with no database server. Mirrors
 * tina4-python/tests/test_execute_raises.py.
 *
 * Run with: npx tsx test/executeRaises.test.ts
 */
import { Database } from "../packages/orm/src/index.ts";
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

function summaryAndExit(code = 0): never {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(code);
}

/** Fresh in-memory Database with one NOT-NULL-constrained table. */
function makeDb(): Database {
  const db = new Database(new SQLiteAdapter(":memory:"));
  // NOTE: synchronous SQLite means execute() resolves immediately, but it is
  // still an async method — every call below is awaited.
  return db;
}

console.log("\n--- Database.execute() raises on error ---");

// ── (a) execute() on a missing table THROWS, getError() populated ────
{
  const db = makeDb();
  await db.execute("CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  await db.commit();

  let threw = false;
  let message = "";
  try {
    await db.execute("INSERT INTO no_such_table (x) VALUES (1)");
  } catch (e: any) {
    threw = true;
    message = e?.message ?? String(e);
  }
  assert("execute() on a missing table THROWS (does not return false)", threw, `(message=${message})`);
  // The cause is still readable through the public API after the throw.
  assert("getError() is populated after the throw", db.getError() !== null, `(got ${db.getError()})`);
}

// ── (b) constraint violation THROWS and the row was NOT written ──────
{
  const db = makeDb();
  await db.execute("CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  await db.commit();

  let threw = false;
  try {
    await db.execute("INSERT INTO widget (id, name) VALUES (1, NULL)");
  } catch {
    threw = true;
  }
  assert("NOT NULL violation THROWS", threw);

  const result = await db.fetch("SELECT * FROM widget");
  assert("the violating row was NOT written (count === 0)", result.count === 0, `(count=${result.count})`);
}

// ── (c) a successful write returns truthy (never false) + clears error ─
{
  const db = makeDb();
  await db.execute("CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  await db.commit();

  // Poison getError() first so we can prove a later success clears it.
  try { await db.execute("INSERT INTO no_such_table (x) VALUES (1)"); } catch { /* expected */ }
  assert("getError() is set after a failed write (precondition)", db.getError() !== null);

  const ok = await db.execute("INSERT INTO widget (id, name) VALUES (1, 'ok')");
  await db.commit();
  assert("successful write returns truthy (never false)", ok !== false && ok !== null && ok !== undefined, `(got ${String(ok)})`);
  assert("successful write clears getError()", db.getError() === null, `(got ${db.getError()})`);

  const result = await db.fetch("SELECT * FROM widget");
  assert("the successful row WAS written (count === 1)", result.count === 1, `(count=${result.count})`);
}

summaryAndExit(fail > 0 ? 1 : 0);
