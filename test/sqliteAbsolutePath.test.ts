/**
 * SQLite absolute-path parity — locks in the `sqlite:/<abs>` footgun fix.
 * Run with: npx tsx test/sqliteAbsolutePath.test.ts
 *
 * REAL SQLite files, no mocks. Two things are pinned here:
 *
 *   1. The fix (footgun): `sqlite:` + a ONE-leading-slash absolute path
 *      (e.g. `sqlite:/<os.tmpdir()>/<uniq>/app.db`) must create/open the DB
 *      at that ABSOLUTE path — never a cwd-relative shadow. Before the fix
 *      this URL fell through parseDatabaseUrl and threw "unsupported scheme".
 *      We connect for real, create a table, insert, assert the file exists at
 *      the absolute path, assert NO cwd-relative shadow was written, then
 *      reopen a fresh connection and read the row back.
 *
 *   2. Documented forms unchanged (no regression):
 *        sqlite:///data/app.db   → relative  "data/app.db"
 *        sqlite:////<abs>         → absolute  "/<abs>"
 *        sqlite::memory: / sqlite:///:memory: → ":memory:" (real connect)
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, parseDatabaseUrl, closeDatabase } from "../packages/orm/src/index.ts";

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

console.log("=== SQLite Absolute-Path Parity Tests ===\n");

// ---------------------------------------------------------------------------
// 1. The fix (footgun): sqlite: + one-leading-slash absolute path
// ---------------------------------------------------------------------------
console.log("--- Footgun: sqlite:/<abs> opens at the absolute path ---");

// mkdtempSync creates the temp dir for us — resolveSqlitePath deliberately
// does NOT auto-mkdir absolute paths outside cwd, so the parent must exist.
const tmpDir = mkdtempSync(join(tmpdir(), "tina4-sqlite-abs-"));
const absDbPath = join(tmpDir, "app.db"); // e.g. /var/folders/.../tina4-sqlite-abs-XXXX/app.db
const footgunUrl = "sqlite:" + absDbPath; // ONE leading slash after the scheme

// Parse: the absolute path must survive untouched (this branch used to throw).
const parsedAbs = parseDatabaseUrl(footgunUrl);
assert("sqlite:/<abs> parses as type sqlite", parsedAbs.engine === "sqlite");
assert("sqlite:/<abs> keeps the absolute path", parsedAbs.database === absDbPath, `got "${parsedAbs.database}"`);

// The cwd-relative shadow a naive join(cwd, path) would have produced.
const shadowPath = join(process.cwd(), absDbPath.replace(/^[/\\]+/, ""));

let db: Database | undefined;
try {
  db = await Database.create(footgunUrl);
  await db.execute("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)");
  await db.execute("INSERT INTO widgets (name) VALUES (?)", ["gizmo"]);

  assert("DB file created at the ABSOLUTE path", existsSync(absDbPath), `expected file at ${absDbPath}`);
  assert("no cwd-relative shadow file was written", !existsSync(shadowPath), `unexpected shadow at ${shadowPath}`);

  const row = await db.fetchOne<{ name: string }>("SELECT name FROM widgets WHERE id = ?", [1]);
  assert("row readable on the live connection", row?.name === "gizmo", `got ${JSON.stringify(row)}`);
} finally {
  // closeDatabase() closes AND clears the global active adapter that
  // Database.create registered — calling db.close() too would double-close it.
  closeDatabase();
}

// Reopen a FRESH connection at the same absolute path — proves the write
// landed on disk at that path, not somewhere transient.
let db2: Database | undefined;
try {
  db2 = await Database.create(footgunUrl);
  const row2 = await db2.fetchOne<{ name: string }>("SELECT name FROM widgets WHERE id = ?", [1]);
  assert("row persisted — readable after reopen at the same abs path", row2?.name === "gizmo", `got ${JSON.stringify(row2)}`);
} finally {
  closeDatabase();
}

assert("still no cwd-relative shadow after reopen", !existsSync(shadowPath), `unexpected shadow at ${shadowPath}`);

// ---------------------------------------------------------------------------
// 2. Documented forms unchanged (no regression)
// ---------------------------------------------------------------------------
console.log("\n--- Documented forms unchanged (no regression) ---");

// Three-slash → relative to cwd; keep raw string form.
assert("sqlite:///data/app.db → relative 'data/app.db'",
  parseDatabaseUrl("sqlite:///data/app.db").database === "data/app.db",
  `got "${parseDatabaseUrl("sqlite:///data/app.db").database}"`);

// Four-slash → absolute. Verify via parse AND a real connect into a temp dir.
const tmpDir2 = mkdtempSync(join(tmpdir(), "tina4-sqlite-fourslash-"));
const absDbPath2 = join(tmpDir2, "four.db");     // starts with "/"
const fourSlashUrl = "sqlite:///" + absDbPath2;  // "sqlite:///" + "/var/..." = "sqlite:////var/..."
assert("sqlite:////<abs> → absolute path (parse)",
  parseDatabaseUrl(fourSlashUrl).database === absDbPath2,
  `got "${parseDatabaseUrl(fourSlashUrl).database}"`);

let db3: Database | undefined;
try {
  db3 = await Database.create(fourSlashUrl);
  await db3.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  await db3.execute("INSERT INTO t (v) VALUES (?)", ["ok"]);
  assert("sqlite:////<abs> real connect creates file at the abs path", existsSync(absDbPath2), `expected file at ${absDbPath2}`);
  const r3 = await db3.fetchOne<{ v: string }>("SELECT v FROM t WHERE id = ?", [1]);
  assert("sqlite:////<abs> row readable", r3?.v === "ok", `got ${JSON.stringify(r3)}`);
} finally {
  closeDatabase();
}

// :memory: — both spellings parse to ":memory:" and a real connect works.
assert("sqlite::memory: → ':memory:'", parseDatabaseUrl("sqlite::memory:").database === ":memory:");
assert("sqlite:///:memory: → ':memory:'", parseDatabaseUrl("sqlite:///:memory:").database === ":memory:");

let mem: Database | undefined;
try {
  mem = await Database.create("sqlite::memory:");
  await mem.execute("CREATE TABLE m (id INTEGER PRIMARY KEY, v TEXT)");
  await mem.execute("INSERT INTO m (v) VALUES (?)", ["mem"]);
  const rm = await mem.fetchOne<{ v: string }>("SELECT v FROM m WHERE id = ?", [1]);
  assert(":memory: real connect works (insert + read back)", rm?.v === "mem", `got ${JSON.stringify(rm)}`);
} finally {
  closeDatabase();
}

// Cleanup temp dirs (and WAL/-shm sidecars).
rmSync(tmpDir, { recursive: true, force: true });
rmSync(tmpDir2, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Summary — matched by test/run-all.ts's "N passed, M failed" parser.
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
