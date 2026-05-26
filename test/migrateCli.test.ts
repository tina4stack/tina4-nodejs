/**
 * Tests for the migrate CLI command — covers the bug where `tina4 migrate`
 * crashed because initDatabase() was called without await, and the bug
 * where loadEnv() never ran so DATABASE_URL from .env was invisible.
 *
 * Run with: npx tsx test/migrateCli.test.ts
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

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

function makeProject(name: string): { dir: string; dbPath: string; envPath: string } {
  const dir = resolve(tmpdir(), `tina4_migrate_cli_${name}_${process.pid}_${Date.now()}`);
  mkdirSync(join(dir, "migrations"), { recursive: true });
  return {
    dir,
    dbPath: join(dir, "test.db"),
    envPath: join(dir, ".env"),
  };
}

function writeMigration(dir: string, name: string, sql: string): void {
  writeFileSync(join(dir, "migrations", name), sql);
}

function resetEnv(): void {
  delete process.env.TINA4_DATABASE_URL;
  delete process.env.DATABASE_URL;
}

function resetAdapter(): void {
  // Force-reset the ORM module-level adapter so each test starts clean.
  // Re-importing won't reset module state in the same process; we have to
  // poke the internal setter directly.
  // Cleared by setAdapter(null as any) via the ORM internals.
}

console.log("=== Migrate CLI — Reload-Aware DB Initialisation ===\n");

// ── Test 1: migrate completes without crashing when .env has TINA4_DATABASE_URL
{
  const { dir, dbPath } = makeProject("happy");
  // Four slashes = absolute path (the adapter strips one leading slash).
  process.env.TINA4_DATABASE_URL = `sqlite:///${dbPath}`;

  writeMigration(
    dir,
    "000001_create_widgets.sql",
    `CREATE TABLE IF NOT EXISTS widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);`,
  );

  const originalCwd = process.cwd();
  process.chdir(dir);

  try {
    // Reset the ORM adapter state so this test does not inherit one from a
    // prior test in the same process.
    const orm = await import("../packages/orm/src/index.js");
    (orm as { setAdapter?: (a: unknown) => void }).setAdapter?.(null);

    // Re-import the migrate module fresh — its module-level imports run once
    // per process, but the runMigrations function itself is reusable.
    const { runMigrations } = await import("../packages/cli/src/commands/migrate.js");
    await runMigrations();

    assert("migrate does not crash with TINA4_DATABASE_URL set", true);
    assert("migration applied to the URL'd database", existsSync(dbPath), `expected ${dbPath}`);
  } catch (err) {
    assert(
      "migrate does not crash with TINA4_DATABASE_URL set",
      false,
      `threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    process.chdir(originalCwd);
    resetEnv();
    rmSync(dir, { recursive: true });
  }
}

// ── Test 2: migrate honours a DATABASE_URL from a project .env file ────
{
  const { dir, dbPath, envPath } = makeProject("dotenv");
  // Note: DO NOT set process.env here. The whole point is that loadEnv()
  // reads .env and populates process.env at runtime.
  resetEnv();

  writeFileSync(envPath, `TINA4_DATABASE_URL=sqlite:///${dbPath}\n`);
  writeMigration(
    dir,
    "000001_create_gadgets.sql",
    `CREATE TABLE IF NOT EXISTS gadgets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);`,
  );

  const originalCwd = process.cwd();
  process.chdir(dir);

  try {
    const orm = await import("../packages/orm/src/index.js");
    (orm as { setAdapter?: (a: unknown) => void }).setAdapter?.(null);

    const { runMigrations } = await import("../packages/cli/src/commands/migrate.js");
    await runMigrations();

    assert("migrate reads TINA4_DATABASE_URL from .env via loadEnv()", existsSync(dbPath), `expected ${dbPath}`);
    assert("migrate does NOT silently fall back to ./data/tina4.db", !existsSync(join(dir, "data", "tina4.db")));
  } catch (err) {
    assert(
      "migrate reads TINA4_DATABASE_URL from .env via loadEnv()",
      false,
      `threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    process.chdir(originalCwd);
    resetEnv();
    rmSync(dir, { recursive: true });
  }
}

// ── Test 3: ensureMigrationTable() does not throw post-await ────────────
// Regression for the original crash: initDatabase() was unawaited so
// setAdapter() had not run by the time ensureMigrationTable() asked for
// the adapter. The whole CLI crashed with "No database adapter configured."
{
  const { dir, dbPath } = makeProject("crash_regression");
  // Four slashes = absolute path (the adapter strips one leading slash).
  process.env.TINA4_DATABASE_URL = `sqlite:///${dbPath}`;

  writeMigration(
    dir,
    "000001_create_thing.sql",
    `CREATE TABLE IF NOT EXISTS things (id INTEGER PRIMARY KEY AUTOINCREMENT);`,
  );

  const originalCwd = process.cwd();
  process.chdir(dir);

  let caught: Error | null = null;
  try {
    const orm = await import("../packages/orm/src/index.js");
    (orm as { setAdapter?: (a: unknown) => void }).setAdapter?.(null);

    const { runMigrations } = await import("../packages/cli/src/commands/migrate.js");
    await runMigrations();
  } catch (err) {
    caught = err instanceof Error ? err : new Error(String(err));
  } finally {
    process.chdir(originalCwd);
    resetEnv();
    rmSync(dir, { recursive: true });
  }

  assert(
    "ensureMigrationTable() does NOT throw 'No database adapter configured'",
    caught === null || !/No database adapter configured/.test(caught.message),
    caught ? `actual error: ${caught.message}` : "",
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
