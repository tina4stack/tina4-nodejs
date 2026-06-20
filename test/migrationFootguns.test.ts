/**
 * Lock-in tests for the migration footgun fixes (v3.13.39).
 * Mirrors Python's tests/test_migration_footguns.py.
 *
 * - [10] `//` delimiter no longer swallows a URL (`https://…`) as a stored-proc block.
 * - [8]  discovery sort is numeric-aware (`9_` before `10_`).
 * - [9]  CREATE TABLE is idempotent on engines lacking IF NOT EXISTS (Firebird/MSSQL),
 *        NOT skipped on SQLite/Postgres (IF NOT EXISTS) or when the table is absent.
 *
 * Run with: npx tsx test/migrationFootguns.test.ts
 */
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  splitStatements,
  normalizeQuotes,
  sortMigrationFiles,
  shouldSkipCreateTable,
  initDatabase,
  closeDatabase,
  getAdapter,
  migrate,
} from "../packages/orm/src/index.ts";
import type { DatabaseAdapter } from "../packages/orm/src/index.ts";

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

console.log("=== Migration Footgun Lock-in Tests ===\n");

// Fake adapters whose constructor.name is the engine discriminator the runner
// uses (engineOf reads constructor.name; adapterTableExists calls tableExists).
class MssqlAdapter {
  constructor(private exists: boolean) {}
  tableExists(_name: string): boolean { return this.exists; }
}
class FirebirdAdapter {
  constructor(private exists: boolean) {}
  tableExists(_name: string): boolean { return this.exists; }
}
class SQLiteAdapter {
  constructor(private exists: boolean) {}
  tableExists(_name: string): boolean { return this.exists; }
}
class PostgresAdapter {
  constructor(private exists: boolean) {}
  tableExists(_name: string): boolean { return this.exists; }
}
const asDb = (a: unknown): DatabaseAdapter => a as DatabaseAdapter;

// ── [10] `//` delimiter must not swallow a URL ──────────────────────────
console.log("--- [10] slash-slash URL guard ---");

{
  const sql =
    "INSERT INTO cfg (k, v) VALUES ('home', 'https://a.example.com');\n" +
    "INSERT INTO cfg (k, v) VALUES ('cb', 'https://b.example.com');";
  const stmts = splitStatements(sql, ";");
  assert(
    "URL `//` not captured as a block — split still yields 2 statements",
    stmts.length === 2,
    `got ${stmts.length}: ${JSON.stringify(stmts)}`,
  );
  assert("first statement keeps its URL", stmts[0]?.includes("https://a.example.com") === true);
  assert("second statement keeps its URL", stmts[1]?.includes("https://b.example.com") === true);
}

{
  // A genuine `// ... //` stored-proc block (delimiters NOT preceded by `:`)
  // is still kept intact as one statement.
  const sql = "CREATE PROCEDURE foo() // BEGIN SELECT 1; SELECT 2; END //;";
  const stmts = splitStatements(sql, ";");
  assert(
    "real `//` stored-proc block still kept intact",
    stmts.some((s) => s.includes("BEGIN SELECT 1; SELECT 2; END")),
    JSON.stringify(stmts),
  );
}

// ── smart/curly quotes normalized so the SQL runs ───────────────────────
console.log("\n--- smart/curly quote normalization ---");

{
  // Smart double quotes around an identifier + smart single quotes around a
  // value — as an editor/doc would produce. They must become straight ASCII so
  // the statement actually runs. Mirrors Python's
  // test_smart_quotes_normalized_before_split.
  const sql = "CREATE TABLE “users” (name TEXT DEFAULT ‘guest’);";
  const joined = splitStatements(sql, ";").join(" ");
  const smartQuotes = ["“", "”", "‘", "’", "′", "″"];
  assert(
    "no smart-quote code points survive splitting",
    smartQuotes.every((q) => !joined.includes(q)),
    JSON.stringify(joined),
  );
  assert('straight "users" present after normalization', joined.includes('"users"'), joined);
  assert("straight 'guest' present after normalization", joined.includes("'guest'"), joined);
}

{
  // Straight quotes and ordinary content are returned byte-for-byte unchanged.
  // Mirrors Python's test_normalize_quotes_preserves_straight_and_content.
  const sql = "INSERT INTO t (v) VALUES ('plain');";
  assert("plain straight-quoted SQL returned unchanged", normalizeQuotes(sql) === sql, normalizeQuotes(sql));
}

// ── [8] numeric-aware discovery order ───────────────────────────────────
console.log("\n--- [8] numeric-aware sort ---");

{
  const names = ["10_b.sql", "9_a.sql", "2_x.sql", "alpha.sql"];
  const sorted = sortMigrationFiles(names);
  assert(
    "9_ sorts before 10_, unprefixed sorts last",
    JSON.stringify(sorted) === JSON.stringify(["2_x.sql", "9_a.sql", "10_b.sql", "alpha.sql"]),
    JSON.stringify(sorted),
  );
}

{
  // Timestamp prefixes (YYYYMMDDHHMMSS) still order correctly alongside sequential.
  const names = ["20240101120000_a.sql", "000002_b.sql", "000001_c.sql"];
  const sorted = sortMigrationFiles(names);
  assert(
    "sequential prefixes sort before a much larger timestamp prefix",
    JSON.stringify(sorted) ===
      JSON.stringify(["000001_c.sql", "000002_b.sql", "20240101120000_a.sql"]),
    JSON.stringify(sorted),
  );
}

// ── [9] CREATE TABLE idempotency on Firebird/MSSQL ──────────────────────
console.log("\n--- [9] CREATE TABLE idempotency ---");

{
  const r = await shouldSkipCreateTable(asDb(new MssqlAdapter(true)), "CREATE TABLE users (id INT)");
  assert("MSSQL + table exists → skip", r !== null && r.includes("users"), String(r));
}
{
  const r = await shouldSkipCreateTable(
    asDb(new FirebirdAdapter(true)),
    'CREATE TABLE "Orders" (id INT)',
  );
  assert("Firebird + quoted table exists → skip", r !== null && r.includes("Orders"), String(r));
}
{
  const r = await shouldSkipCreateTable(
    asDb(new FirebirdAdapter(false)),
    "CREATE TABLE users (id INT)",
  );
  assert("Firebird + table absent → NOT skipped (null)", r === null, String(r));
}
{
  const rSqlite = await shouldSkipCreateTable(
    asDb(new SQLiteAdapter(true)),
    "CREATE TABLE users (id INT)",
  );
  const rPg = await shouldSkipCreateTable(
    asDb(new PostgresAdapter(true)),
    "CREATE TABLE users (id INT)",
  );
  assert("SQLite → never skipped by this guard (IF NOT EXISTS)", rSqlite === null, String(rSqlite));
  assert("Postgres → never skipped by this guard (IF NOT EXISTS)", rPg === null, String(rPg));
}
{
  const r = await shouldSkipCreateTable(
    asDb(new MssqlAdapter(true)),
    "INSERT INTO users VALUES (1)",
  );
  assert("non-CREATE statement ignored (null)", r === null, String(r));
}

// ── G3 (data-integrity): migrate() STOPS at the first failed file ───────
console.log("\n--- G3: stop at first failure ---");

{
  const TMP = "/tmp/tina4-migration-footgun-g3";
  const MIGS = join(TMP, "migrations");
  try { rmSync(TMP, { recursive: true }); } catch { /* fresh */ }
  mkdirSync(MIGS, { recursive: true });

  // 1 good, 2 bad (syntax error), 3 good — file 3 must NOT be applied after 2 fails.
  writeFileSync(join(MIGS, "000001_a.sql"), 'CREATE TABLE "g3_a" (id INTEGER PRIMARY KEY);');
  writeFileSync(join(MIGS, "000002_b.sql"), "THIS IS NOT VALID SQL;");
  writeFileSync(join(MIGS, "000003_c.sql"), 'CREATE TABLE "g3_c" (id INTEGER PRIMARY KEY);');

  await initDatabase({ type: "sqlite", path: join(TMP, "test.db") });
  const db = getAdapter();

  const result = await migrate(db, { migrationsDir: MIGS });

  assert("file 1 applied", result.applied.includes("000001_a.sql"), JSON.stringify(result));
  assert("file 2 failed", result.failed.includes("000002_b.sql"), JSON.stringify(result));
  assert(
    "file 3 NOT applied (stopped at first failure)",
    !result.applied.includes("000003_c.sql"),
    JSON.stringify(result),
  );
  // The table from the later file must never exist — proves we stopped.
  assert("later migration's table never created", !(db as any).tableExists("g3_c"));
  assert("earlier migration's table exists", (db as any).tableExists("g3_a"));

  closeDatabase();
  try { rmSync(TMP, { recursive: true }); } catch { /* ignore */ }
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
