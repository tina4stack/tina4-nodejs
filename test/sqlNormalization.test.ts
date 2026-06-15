/**
 * Tina4 Node.js — v3.13.12 SQL normalization.
 *
 * The framework's Database.fetch() / fetchOne() pass user SQL to the
 * adapter, which wraps with LIMIT/OFFSET (SQLite/MySQL/PG/Firebird)
 * or OFFSET/FETCH (MSSQL). A trailing `;` in the user's input breaks
 * the appended clause — `"SELECT * FROM t; LIMIT 100 OFFSET 0"` is a
 * syntax error on every engine.
 *
 * This test pins:
 *   1. The exported `stripTrailingSemicolons` helper.
 *   2. Database.fetch / fetchOne actually survive a user-supplied
 *      trailing `;` against a real SQLite database.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, closeDatabase, stripTrailingSemicolons } from "../packages/orm/src/index.ts";

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

console.log("=== SQL normalization (v3.13.12) ===\n");

// ── Unit: the helper itself ────────────────────────────────────────
console.log("--- stripTrailingSemicolons (unit) ---");
assert("clean SQL unchanged", stripTrailingSemicolons("SELECT 1") === "SELECT 1");
assert("single trailing ;", stripTrailingSemicolons("SELECT 1;") === "SELECT 1");
assert("trailing whitespace + ;", stripTrailingSemicolons("SELECT 1   ;   ") === "SELECT 1");
assert("multiple trailing ;", stripTrailingSemicolons("SELECT 1;;;") === "SELECT 1");
assert("newline + ;", stripTrailingSemicolons("SELECT 1\n;\n") === "SELECT 1");
assert("empty string passthrough", stripTrailingSemicolons("") === "");
assert("all-semicolons", stripTrailingSemicolons(";;;") === "");
assert("trailing ; after string literal", stripTrailingSemicolons("SELECT ';' AS x;") === "SELECT ';' AS x");

// ── Integration: Database.fetch survives trailing ; ────────────────
console.log("\n--- Database.fetch survives trailing ; ---");
const tmp = mkdtempSync(join(tmpdir(), "tina4-sql-norm-"));
const dbPath = join(tmp, "test.db");

try {
  const db = await initDatabase({ url: `sqlite:///${dbPath}` });
  await db.execute("CREATE TABLE widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
  for (let i = 0; i < 5; i++) {
    await db.execute("INSERT INTO widgets (name) VALUES (?)", [`widget-${i}`]);
  }

  {
    // Pre-v3.13.12: SQLite throws "near ';': syntax error" because
    // fetch appends ` LIMIT N OFFSET M` after the user SQL.
    const result = await db.fetch("SELECT * FROM widgets;");
    assert("fetch returns 5 rows for trailing ;", result.records.length === 5);
  }

  {
    const result = await db.fetch("SELECT * FROM widgets;;");
    assert("fetch returns 5 rows for double ;;", result.records.length === 5);
  }

  {
    const row = await db.fetchOne("SELECT * FROM widgets WHERE id = ?;", [1]);
    assert("fetchOne returns row for trailing ;", row !== null && (row as any).name === "widget-0");
  }

  {
    // Clean SQL still works
    const result = await db.fetch("SELECT * FROM widgets WHERE name = ?", ["widget-2"]);
    assert("clean SQL unchanged", result.records.length === 1);
  }
} finally {
  try { await closeDatabase(); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

// ── v3.13.12: fetchAll returns ALL rows (no silent truncation) ────
console.log("\n--- fetchAll returns ALL rows by default ---");
const tmpAll = mkdtempSync(join(tmpdir(), "tina4-fetch-all-"));
const dbAllPath = join(tmpAll, "big.db");

try {
  const db = await initDatabase({ url: `sqlite:///${dbAllPath}` });
  await db.execute("CREATE TABLE rows (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER)");
  // 150 rows — bigger than any silent-truncation default
  for (let i = 0; i < 150; i++) {
    await db.execute("INSERT INTO rows (n) VALUES (?)", [i]);
  }

  {
    const rows = await db.fetchAll("SELECT * FROM rows ORDER BY n");
    assert(
      "fetchAll returns ALL 150 rows by default",
      rows.length === 150,
      `(got ${rows.length})`,
    );
  }

  {
    const rows = await db.fetchAll("SELECT * FROM rows ORDER BY n", undefined, 10);
    assert("fetchAll with explicit limit=10 caps to 10", rows.length === 10);
  }

  {
    const rows = await db.fetchAll("SELECT * FROM rows ORDER BY n", undefined, 5, 20);
    assert(
      "fetchAll with limit=5, offset=20 returns slice",
      rows.length === 5 && (rows[0] as any).n === 20 && (rows[4] as any).n === 24,
    );
  }

  {
    // Composes with the trailing-; strip — fetchAll with both features in play
    const rows = await db.fetchAll("SELECT * FROM rows ORDER BY n;");
    assert("fetchAll + trailing ; → all 150 rows", rows.length === 150);
  }
} finally {
  try { await closeDatabase(); } catch {}
  rmSync(tmpAll, { recursive: true, force: true });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
