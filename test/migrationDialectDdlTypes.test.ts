/**
 * Migration-dialect DDL-types fix — Node port of the proven Python fix.
 *
 * The scaffolding used to emit SQLite-only DDL (`TEXT` for STRING fields, `TEXT`
 * for `created_at`) that Firebird rejects (-607 on `TEXT`) and MSSQL mis-types
 * (its `TIMESTAMP` is a rowversion, not a datetime). The fix is two parts, both
 * exercised here:
 *
 *   * the generator emits portable canonical types (`VARCHAR(255)` for strings,
 *     `TIMESTAMP` for datetimes / `created_at`), and
 *   * `SQLTranslator.ddlTypes` completes the apply-time translation so `TEXT` ->
 *     `BLOB SUB_TYPE TEXT`, `REAL` -> `DOUBLE PRECISION`, and `IF NOT EXISTS` is
 *     stripped on Firebird (`TIMESTAMP` -> `DATETIME2` on MSSQL, `DATETIME` on
 *     MySQL). Each adapter's `translateSql` now applies `autoIncrementSyntax` +
 *     `ddlTypes` so ONE portable migration applies on every engine.
 *
 * No mocks: the translation-unit tests are pure functions over strings; the
 * wiring tests instantiate the REAL adapters (their constructors open no
 * connection) and call `translateSql`; the generator test runs the REAL CLI; and
 * the round-trip runs against a LIVE Firebird (`TINA4_TEST_FIREBIRD_URL`) applying
 * the REALLY-generated migration DDL, then inserts and reads a row.
 *
 * Mirrors tina4-python/tests/test_migration_dialect_firebird.py.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SQLTranslator,
  FirebirdAdapter,
  MysqlAdapter,
  MssqlAdapter,
  initDatabase,
} from "../packages/orm/src/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(repoRoot, "node_modules/.bin/tsx");
const cliBin = join(repoRoot, "packages/cli/src/bin.ts");
const FIREBIRD_URL = process.env.TINA4_TEST_FIREBIRD_URL;

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(name: string, why: string): void {
  skipped++;
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${why}`);
}

function countOf(haystack: string, needle: RegExp): number {
  return (haystack.match(needle) ?? []).length;
}

// A BLOB SUB_TYPE TEXT column comes back as a Buffer (raw bytes); a plain text
// column as a string. Read either out to a string for comparison.
function textOf(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString("utf-8") : String(value);
}

// The SQLite-canonical DDL a portable migration carries (no AUTOINCREMENT — the
// pure ddlTypes tests cover TYPE translation only, matching the Python master).
const RAW =
  "CREATE TABLE IF NOT EXISTS t (\n" +
  "  id INTEGER PRIMARY KEY,\n" +
  "  bio TEXT,\n" +
  "  price REAL,\n" +
  "  due TIMESTAMP\n)";

console.log("=== Migration-dialect DDL types (ddlTypes) ===\n");

// ── 1. Pure ddlTypes (mirror TestDdlTypesTranslationPure) ─────────────────
console.log("--- ddlTypes: pure translation ---");
{
  const fb = SQLTranslator.ddlTypes(RAW, "firebird");
  ok("firebird strips IF NOT EXISTS", !/IF NOT EXISTS/i.test(fb), fb);
  ok("firebird TEXT -> BLOB SUB_TYPE TEXT", fb.includes("BLOB SUB_TYPE TEXT"));
  ok("firebird REAL -> DOUBLE PRECISION", fb.includes("DOUBLE PRECISION"));
  // No bare TEXT/REAL survive (BLOB SUB_TYPE TEXT is not a bare TEXT).
  const upper = fb.toUpperCase();
  ok(
    "firebird no bare TEXT survives",
    countOf(upper, /TEXT/g) === countOf(upper, /SUB_TYPE TEXT/g),
    fb,
  );
  ok("firebird no bare REAL survives", !/\bREAL\b/.test(upper));

  const ms = SQLTranslator.ddlTypes(RAW, "mssql");
  ok("mssql strips IF NOT EXISTS", !/IF NOT EXISTS/i.test(ms));
  ok(
    "mssql TIMESTAMP -> DATETIME2",
    ms.includes("DATETIME2") && !/\bTIMESTAMP\b/i.test(ms),
    ms,
  );

  const my = SQLTranslator.ddlTypes(RAW, "mysql");
  ok(
    "mysql TIMESTAMP -> DATETIME",
    /\bDATETIME\b/i.test(my) && !/\bTIMESTAMP\b/i.test(my),
    my,
  );

  // DDL-gated: a SELECT that merely mentions TEXT/REAL is unchanged.
  const q = "SELECT id, note FROM t WHERE kind = 'TEXT' AND ratio > 0.5";
  ok("ddlTypes is DDL-gated (SELECT untouched)", SQLTranslator.ddlTypes(q, "firebird") === q);

  // Leading `-- ...` comment lines (what a migration file carries) do not defeat
  // the gate.
  const commented = "-- Migration: x\n-- Created: now\n\n" + RAW;
  const fbc = SQLTranslator.ddlTypes(commented, "firebird");
  ok(
    "leading comments do not defeat the gate",
    fbc.includes("BLOB SUB_TYPE TEXT") && !/IF NOT EXISTS/i.test(fbc),
  );

  // PostgreSQL / SQLite are unchanged (their canonical DDL is the source form).
  ok("postgres unchanged", SQLTranslator.ddlTypes(RAW, "postgres") === RAW);
  ok("sqlite unchanged", SQLTranslator.ddlTypes(RAW, "sqlite") === RAW);
}

// ── 2. Adapter translateSql wiring (autoIncrementSyntax + ddlTypes) ───────
console.log("\n--- adapter translateSql wiring ---");
{
  const DDL =
    "CREATE TABLE IF NOT EXISTS t (\n" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
    "  bio TEXT,\n" +
    "  price REAL,\n" +
    "  due TIMESTAMP\n)";

  const fb = new FirebirdAdapter("firebird://localhost:3050/x.fdb").translateSql(DDL);
  ok("firebird adapter strips AUTOINCREMENT", !/AUTOINCREMENT/i.test(fb), fb);
  ok(
    "firebird adapter maps TEXT + REAL + drops IF NOT EXISTS",
    fb.includes("BLOB SUB_TYPE TEXT") && fb.includes("DOUBLE PRECISION") && !/IF NOT EXISTS/i.test(fb),
    fb,
  );

  const my = new MysqlAdapter("mysql://localhost:3306/x").translateSql(DDL);
  ok("mysql adapter AUTOINCREMENT -> AUTO_INCREMENT", my.includes("AUTO_INCREMENT"), my);
  ok(
    "mysql adapter TIMESTAMP -> DATETIME",
    /\bDATETIME\b/i.test(my) && !/\bTIMESTAMP\b/i.test(my),
    my,
  );

  const ms = new MssqlAdapter("mssql://localhost:1433/x").translateSql(DDL);
  ok("mssql adapter AUTOINCREMENT -> IDENTITY(1,1)", ms.includes("IDENTITY(1,1)"), ms);
  ok(
    "mssql adapter TIMESTAMP -> DATETIME2 + drops IF NOT EXISTS",
    ms.includes("DATETIME2") && !/IF NOT EXISTS/i.test(ms),
    ms,
  );

  // Negative: DML is NOT type-rewritten by translateSql (ddlTypes is DDL-gated).
  const sel = "SELECT id FROM t WHERE kind = 'TEXT'";
  const fbSel = new FirebirdAdapter("firebird://localhost:3050/x.fdb").translateSql(sel);
  ok(
    "firebird adapter leaves DML type-words intact",
    fbSel.includes("'TEXT'") && !fbSel.includes("BLOB SUB_TYPE TEXT"),
    fbSel,
  );
}

// ── 3. Generator emits portable types (real CLI) ─────────────────────────
console.log("\n--- generator emits portable types (real CLI) ---");

function generateCreateSql(): { createStmt: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "tina4-ddl-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  execFileSync(
    tsxBin,
    [
      cliBin, "generate", "migration", "create_dialect_probe",
      "--fields", "name:string,bio:text,price:float,active:bool,due:datetime",
    ],
    { cwd: dir, env: process.env, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 },
  );
  const migDir = join(dir, "migrations");
  const upFile = readdirSync(migDir).find(
    (f) => f.endsWith(".sql") && !f.endsWith(".down.sql") && f.includes("create_dialect_probe"),
  );
  if (!upFile) throw new Error(`no generated migration in ${migDir}: ${readdirSync(migDir).join(", ")}`);
  const fullSql = readFileSync(join(migDir, upFile), "utf-8");
  // The generator writes exactly one CREATE TABLE per up-file.
  const createStmt = fullSql.split(";").find((s) => /CREATE\s+TABLE/i.test(s)) ?? "";
  return { createStmt, dir };
}

let generated: { createStmt: string; dir: string } | null = null;
try {
  generated = generateCreateSql();
  const sql = generated.createStmt;
  ok("generator: name VARCHAR(255)", sql.includes("name VARCHAR(255)"), sql);
  ok("generator: not SQLite-only 'name TEXT'", !sql.includes("name TEXT"));
  ok("generator: created_at TIMESTAMP", sql.includes("created_at TIMESTAMP"));
  ok("generator: not 'created_at TEXT' (Firebird -607 guard)", !sql.includes("created_at TEXT"));
} catch (err) {
  ok("generator runs", false, (err as Error).message);
}

// ── 4. Live Firebird round-trip (the real proof) ─────────────────────────
console.log("\n--- live Firebird round-trip ---");
if (!FIREBIRD_URL) {
  skip(
    "generated migration applies + row round-trips",
    "TINA4_TEST_FIREBIRD_URL not set (needs a live Firebird)",
  );
} else if (!generated?.createStmt) {
  ok("generated migration applies + row round-trips", false, "generator produced no CREATE statement");
} else {
  const db: any = await initDatabase({ url: FIREBIRD_URL });
  try {
    try { await db.execute("DROP TABLE dialect_probe"); } catch { /* first run: nothing to drop */ }
    // db.execute() runs the adapter's translateSql -> autoIncrementSyntax +
    // ddlTypes, so the SQLite-canonical generated DDL (TEXT / REAL / AUTOINCREMENT
    // / IF NOT EXISTS) is made Firebird-legal on the way in — where the old DDL
    // raised -607.
    await db.execute(generated.createStmt);
    await db.execute(
      "INSERT INTO dialect_probe (id, name, bio, price, active, due) VALUES (?, ?, ?, ?, ?, ?)",
      [1, "Alice", "a long bio", 9.99, 1, "2026-01-02 03:04:05"],
    );
    const row: any = await db.fetchOne(
      "SELECT id, name, bio, price FROM dialect_probe WHERE id = ?",
      [1],
    );
    ok("live: row found", row != null, JSON.stringify(row));
    ok("live: name round-trips", row?.name === "Alice", `${row?.name}`);
    ok(
      "live: bio (BLOB SUB_TYPE TEXT) round-trips",
      textOf(row?.bio) === "a long bio",
      `${row?.bio}`,
    );
    ok(
      "live: price (DOUBLE PRECISION) round-trips",
      Math.abs(Number(row?.price) - 9.99) < 1e-6,
      `${row?.price}`,
    );
  } catch (err) {
    ok("generated migration applies + row round-trips", false, `threw: ${(err as Error).message}`);
  } finally {
    try { await db.execute("DROP TABLE dialect_probe"); } catch { /* ignore */ }
    try { await db.close(); } catch { /* already gone */ }
  }
}

if (generated) {
  try { rmSync(generated.dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n  Results: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
// node-firebird can leave a handle open after close(); exit explicitly so the
// runner does not time out on a 100%-pass run (mirrors firebirdProviderContract).
process.exit(failed > 0 ? 1 : 0);
