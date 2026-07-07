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
  parseSetTerm,
  normalizeQuotes,
  sortMigrationFiles,
  shouldSkipCreateTable,
  initDatabase,
  closeDatabase,
  getAdapter,
  migrate,
  ensureMigrationTable,
  adapterExecute,
  adapterQuery,
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

// ── [#54] a ';' inside a comment or string literal must NOT split a statement ──
console.log("\n--- [#54] comment/string-aware split ---");

{
  // The exact issue #54 repro: a ';' inside a '-- …' line comment used to
  // fragment this ONE CREATE TABLE into broken pieces.
  const sql =
    "CREATE TABLE users (\n" +
    "    id INTEGER PRIMARY KEY,   -- drop then re-add; old way\n" +
    "    name TEXT NOT NULL\n" +
    ");";
  const stmts = splitStatements(sql, ";");
  assert(
    "';' inside a -- comment does not fragment the statement",
    stmts.length === 1,
    `got ${stmts.length}: ${JSON.stringify(stmts)}`,
  );
  assert("real columns survive intact", stmts[0]?.includes("id INTEGER PRIMARY KEY") === true && stmts[0]?.includes("name TEXT NOT NULL") === true);
  assert("line comment text is stripped", stmts[0]?.includes("old way") === false, JSON.stringify(stmts));
}

{
  const sql = "CREATE TABLE t (id INTEGER /* a; b; c */, name TEXT);";
  const stmts = splitStatements(sql, ";");
  assert("';' inside a /* */ comment does not fragment", stmts.length === 1, JSON.stringify(stmts));
  assert("block comment text is stripped", stmts[0]?.includes("a; b; c") === false, JSON.stringify(stmts));
}

{
  const sql = "INSERT INTO t (v) VALUES ('a;b;c'); INSERT INTO t (v) VALUES ('d');";
  const stmts = splitStatements(sql, ";");
  assert("';' inside a string literal does not split", stmts.length === 2, JSON.stringify(stmts));
  assert("string-literal content is preserved", stmts[0]?.includes("'a;b;c'") === true, JSON.stringify(stmts));
}

{
  const sql = "INSERT INTO t (v) VALUES ('a--b'); INSERT INTO t (v) VALUES ('c');";
  const stmts = splitStatements(sql, ";");
  assert("'--' inside a string literal is not a comment", stmts.length === 2, JSON.stringify(stmts));
  assert("the '--' string content survives", stmts[0]?.includes("'a--b'") === true, JSON.stringify(stmts));
}

{
  const sql = "INSERT INTO t (v) VALUES ('O''Brien; Jr'); SELECT 1;";
  const stmts = splitStatements(sql, ";");
  assert("doubled-quote '' escape keeps the ';' inside the literal", stmts.length === 2, JSON.stringify(stmts));
  assert("escaped-quote literal preserved", stmts[0]?.includes("'O''Brien; Jr'") === true, JSON.stringify(stmts));
}

{
  // End-to-end against a REAL temp SQLite DB (no mocks): the issue's repro
  // migration must apply cleanly and create the table.
  const TMP = "/tmp/tina4-migration-issue54";
  const MIGS = join(TMP, "migrations");
  try { rmSync(TMP, { recursive: true }); } catch { /* fresh */ }
  mkdirSync(MIGS, { recursive: true });
  writeFileSync(
    join(MIGS, "000001_create_users.sql"),
    "CREATE TABLE users (\n" +
      "    id INTEGER PRIMARY KEY,   -- drop then re-add; old way\n" +
      "    name TEXT NOT NULL\n" +
      ");",
  );

  await initDatabase({ type: "sqlite", path: join(TMP, "test.db") });
  const db = getAdapter();
  const result = await migrate(db, { migrationsDir: MIGS });

  assert("issue #54 migration applied cleanly", result.applied.includes("000001_create_users.sql"), JSON.stringify(result));
  assert("issue #54 migration did not fail", !result.failed.includes("000001_create_users.sql"), JSON.stringify(result));
  assert("users table created from the repro migration", (db as any).tableExists("users"), JSON.stringify(result));

  closeDatabase();
  try { rmSync(TMP, { recursive: true }); } catch { /* ignore */ }
}

// ── SET TERM switches the terminator so PSQL bodies survive ──────────────
//
// A Firebird trigger / procedure / EXECUTE BLOCK body has ';'-terminated inner
// statements; under the default ';' runner it must survive as ONE statement, not
// be split on those inner ';'. A `SET TERM <new> <cur>` directive switches the
// terminator so the body stays intact. Mirrors Python/PHP/Ruby.
{
  const sql =
    "SET TERM ^ ;\n" +
    "CREATE OR ALTER TRIGGER t_bi FOR t ACTIVE BEFORE INSERT AS\n" +
    "BEGIN\n" +
    "  IF (NEW.id IS NULL) THEN NEW.id = GEN_ID(GEN_T, 1);\n" +
    "END^\n" +
    "SET TERM ; ^";
  const stmts = splitStatements(sql, ";");
  assert("SET TERM keeps a trigger body intact (1 stmt)", stmts.length === 1, JSON.stringify(stmts));
  assert("SET TERM trigger body starts with CREATE", stmts[0]?.startsWith("CREATE OR ALTER TRIGGER") ?? false, JSON.stringify(stmts));
  assert("SET TERM trigger body ends with END", stmts[0]?.endsWith("END") ?? false, JSON.stringify(stmts));
  assert("SET TERM keeps inner ';' inside the body", stmts[0]?.includes("NEW.id = GEN_ID(GEN_T, 1);") ?? false, JSON.stringify(stmts));
}

{
  const sql = "SET TERM ^ ;\nEXECUTE BLOCK AS BEGIN a; b; END^\nSET TERM ; ^";
  const stmts = splitStatements(sql, ";");
  assert("SET TERM directives consumed, one stmt", stmts.length === 1, JSON.stringify(stmts));
  assert("SET TERM never emitted as SQL", stmts.every((s) => !s.includes("SET TERM")), JSON.stringify(stmts));
}

{
  // After `SET TERM ; ^`, plain ';' splitting resumes.
  const sql =
    "CREATE TABLE a (id INT);\n" +
    "SET TERM ^ ;\n" +
    "CREATE TRIGGER a_bi FOR a AS BEGIN NEW.id = 1; END^\n" +
    "SET TERM ; ^\n" +
    "INSERT INTO a VALUES (1);\nUPDATE a SET id = 2;";
  const stmts = splitStatements(sql, ";");
  assert("SET TERM restores ';' after the block (4 stmts)", stmts.length === 4, JSON.stringify(stmts));
  assert("SET TERM restore: stmt0 CREATE TABLE", stmts[0]?.startsWith("CREATE TABLE") ?? false, JSON.stringify(stmts));
  assert("SET TERM restore: stmt1 CREATE TRIGGER", stmts[1]?.startsWith("CREATE TRIGGER") ?? false, JSON.stringify(stmts));
  assert("SET TERM restore: stmt2 INSERT", stmts[2]?.startsWith("INSERT INTO") ?? false, JSON.stringify(stmts));
  assert("SET TERM restore: stmt3 UPDATE", stmts[3]?.startsWith("UPDATE") ?? false, JSON.stringify(stmts));
}

{
  const sql = "SET TERM !! ;\nCREATE TRIGGER t FOR x AS BEGIN NEW.a = 1; END!!\nSET TERM ; !!";
  const stmts = splitStatements(sql, ";");
  assert("SET TERM supports a multi-char terminator (1 stmt)", stmts.length === 1, JSON.stringify(stmts));
  assert("SET TERM multi-char: terminator stripped", !(stmts[0]?.includes("!!") ?? true), JSON.stringify(stmts));
  assert("SET TERM multi-char: directive not emitted", !(stmts[0]?.includes("SET TERM") ?? true), JSON.stringify(stmts));
}

{
  // No SET TERM -> ordinary ';' splitting, behaviour unchanged.
  const sql = "CREATE TABLE a (id INT);\nINSERT INTO a VALUES (1);\nUPDATE a SET id = 2;";
  const stmts = splitStatements(sql, ";");
  assert("plain ';' script unaffected by SET TERM support (3 stmts)", stmts.length === 3, JSON.stringify(stmts));
  assert("plain ';' script: no trailing ';' kept", stmts.every((s) => !s.endsWith(";")), JSON.stringify(stmts));
}

{
  assert("parseSetTerm recognises 'SET TERM ^'", parseSetTerm("SET TERM ^") === "^");
  assert("parseSetTerm is case-insensitive ('set term !!')", parseSetTerm("set term !!") === "!!");
  assert("parseSetTerm ignores ordinary DDL", parseSetTerm("CREATE TABLE a (id INT)") === null);
  assert("parseSetTerm ignores a quoted literal", parseSetTerm("SELECT 'SET TERM ^ ;'") === null);
}

// ── 3.13.55: canonical tina4_migration schema (migration_name) ──────────
//
// Aligns the bookkeeping table to the shape shared across all 4 frameworks:
//   id, migration_name (UNIQUE), description, batch, executed_at, passed.
// A migration is "applied" iff a row exists with passed = 1. NO MOCKS — real
// node:sqlite throughout.
console.log("\n--- 3.13.55 canonical migration schema (NO MOCKS, real sqlite) ---");

// (a) A freshly-created tracking table has the canonical 6 columns and none of
//     the legacy `name`/`applied_at` columns.
{
  const TMP = "/tmp/tina4-mig-canonical-fresh";
  try { rmSync(TMP, { recursive: true }); } catch { /* fresh */ }
  mkdirSync(TMP, { recursive: true });

  await initDatabase({ type: "sqlite", path: join(TMP, "test.db") });
  const db = getAdapter();
  await ensureMigrationTable();

  const cols = new Set(
    (db as any).getTableColumns("tina4_migration").map((c: any) => c.name.toLowerCase()),
  );
  for (const c of ["id", "migration_name", "description", "batch", "executed_at", "passed"]) {
    assert(`fresh tina4_migration has canonical column '${c}'`, cols.has(c), JSON.stringify([...cols]));
  }
  assert("fresh table drops the legacy 'name' column", !cols.has("name"), JSON.stringify([...cols]));
  assert("fresh table drops the legacy 'applied_at' column", !cols.has("applied_at"), JSON.stringify([...cols]));

  // ensureMigrationTable() is idempotent — a second call must not throw or churn.
  await ensureMigrationTable();
  const cols2 = new Set(
    (db as any).getTableColumns("tina4_migration").map((c: any) => c.name.toLowerCase()),
  );
  assert("ensureMigrationTable is idempotent (still canonical)", cols2.has("migration_name") && !cols2.has("name"), JSON.stringify([...cols2]));

  closeDatabase();
  try { rmSync(TMP, { recursive: true }); } catch { /* ignore */ }
}

// (b) record + read round-trip; a second migrate() does NOT re-run the applied
//     migration.
{
  const TMP = "/tmp/tina4-mig-canonical-rt";
  const MIGS = join(TMP, "migrations");
  try { rmSync(TMP, { recursive: true }); } catch { /* fresh */ }
  mkdirSync(MIGS, { recursive: true });
  writeFileSync(join(MIGS, "000001_widgets.sql"), "CREATE TABLE canon_widgets (id INTEGER PRIMARY KEY, name TEXT);");

  await initDatabase({ type: "sqlite", path: join(TMP, "test.db") });
  const db = getAdapter();

  const r1 = await migrate(db, { migrationsDir: MIGS });
  assert("canonical: first migrate applies the file", r1.applied.includes("000001_widgets.sql"), JSON.stringify(r1));
  assert("canonical: migration body ran (table created)", (db as any).tableExists("canon_widgets"));

  const rows = await adapterQuery<{ migration_name: string; description: string; batch: number; executed_at: string; passed: number }>(
    db,
    `SELECT migration_name, description, batch, executed_at, passed FROM "tina4_migration"`,
  );
  assert("canonical: exactly one tracking row", rows.length === 1, JSON.stringify(rows));
  assert("canonical: migration_name stored (not name)", rows[0]?.migration_name === "000001_widgets", JSON.stringify(rows));
  assert("canonical: description derived from the name", rows[0]?.description === "widgets", JSON.stringify(rows));
  assert("canonical: passed = 1", Number(rows[0]?.passed) === 1, JSON.stringify(rows));
  assert(
    "canonical: executed_at is an explicit ISO-8601 string",
    typeof rows[0]?.executed_at === "string" && rows[0].executed_at.includes("T") && rows[0].executed_at.endsWith("Z"),
    JSON.stringify(rows),
  );

  const r2 = await migrate(db, { migrationsDir: MIGS });
  assert(
    "canonical: second migrate does NOT re-run the applied migration",
    r2.applied.length === 0 && r2.skipped.includes("000001_widgets.sql"),
    JSON.stringify(r2),
  );

  closeDatabase();
  try { rmSync(TMP, { recursive: true }); } catch { /* ignore */ }
}

// (c) An OLD-v3 table (id, name, batch, applied_at — NO migration_name /
//     description / passed) with an already-applied row is upgraded in place:
//     migration_name/executed_at are backfilled from name/applied_at, and the
//     already-applied migration is NOT re-run.
{
  const TMP = "/tmp/tina4-mig-canonical-upgrade";
  const MIGS = join(TMP, "migrations");
  try { rmSync(TMP, { recursive: true }); } catch { /* fresh */ }
  mkdirSync(MIGS, { recursive: true });
  // The real migration file whose row we pre-seed as already applied. If it were
  // re-run, it would (re-)create `legacy_created` — which must NOT happen.
  writeFileSync(join(MIGS, "000001_legacy.sql"), "CREATE TABLE legacy_created (id INTEGER PRIMARY KEY);");

  await initDatabase({ type: "sqlite", path: join(TMP, "test.db") });
  const db = getAdapter();

  // Manually build the OLD-v3 shaped tracking table + one applied row.
  await adapterExecute(db, `CREATE TABLE "tina4_migration" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(500) NOT NULL,
    batch INTEGER NOT NULL DEFAULT 1,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await adapterExecute(db,
    `INSERT INTO "tina4_migration" (name, batch, applied_at) VALUES (?, ?, ?)`,
    ["000001_legacy", 1, "2026-01-01T00:00:00.000Z"],
  );

  const r = await migrate(db, { migrationsDir: MIGS });
  assert("upgrade: already-applied legacy migration is NOT re-applied", !r.applied.includes("000001_legacy.sql"), JSON.stringify(r));
  assert("upgrade: legacy migration reported as skipped", r.skipped.includes("000001_legacy.sql"), JSON.stringify(r));
  assert("upgrade: legacy migration body did NOT re-execute", !(db as any).tableExists("legacy_created"));

  const cols = new Set(
    (db as any).getTableColumns("tina4_migration").map((c: any) => c.name.toLowerCase()),
  );
  assert("upgrade: migration_name column added in place", cols.has("migration_name"), JSON.stringify([...cols]));
  assert("upgrade: description column added in place", cols.has("description"), JSON.stringify([...cols]));
  assert("upgrade: passed column added in place", cols.has("passed"), JSON.stringify([...cols]));
  assert("upgrade: executed_at column added in place", cols.has("executed_at"), JSON.stringify([...cols]));
  assert("upgrade: legacy 'name' column left in place", cols.has("name"), JSON.stringify([...cols]));

  const rows = await adapterQuery<{ name: string; migration_name: string; passed: number; executed_at: string }>(
    db,
    `SELECT name, migration_name, passed, executed_at FROM "tina4_migration"`,
  );
  assert("upgrade: exactly one row after upgrade", rows.length === 1, JSON.stringify(rows));
  assert("upgrade: migration_name copied from name", rows[0]?.migration_name === "000001_legacy", JSON.stringify(rows));
  assert("upgrade: passed backfilled to 1", Number(rows[0]?.passed) === 1, JSON.stringify(rows));
  assert("upgrade: executed_at copied from applied_at", rows[0]?.executed_at === "2026-01-01T00:00:00.000Z", JSON.stringify(rows));

  closeDatabase();
  try { rmSync(TMP, { recursive: true }); } catch { /* ignore */ }
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
