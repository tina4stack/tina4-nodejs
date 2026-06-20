/**
 * Tests for startup auto-migration (autoMigrateOnStartup in server.ts).
 * Run with: npx tsx test/autoMigrate.test.ts
 *
 * Covers the 4 cases:
 *   1. migrations/ dir + .sql files + flag on (default) → pending migrations applied
 *   2. TINA4_AUTO_MIGRATE falsy → skipped (no tables created)
 *   3. no migrations/ dir → silent no-op (never throws)
 *   4. a failing migration → logged, NEVER re-raised (boot continues)
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoMigrateOnStartup } from "../packages/core/src/server.ts";
import { initDatabase, getAdapter, closeDatabase } from "../packages/orm/src/index.ts";

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

/** Make a fresh project base dir with an in-memory-ish sqlite DB bound. */
async function freshProject(): Promise<string> {
  const base = mkdtempSync(join(tmpdir(), "tina4-automig-"));
  // Each test gets its own on-disk sqlite file so adapters don't collide.
  await initDatabase({ url: `sqlite://${join(base, "test.db")}` });
  return base;
}

function writeMigration(base: string, name: string, sql: string): void {
  const dir = join(base, "migrations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), sql, "utf-8");
}

function tableExists(name: string): boolean {
  try {
    return getAdapter().tableExists(name);
  } catch {
    return false;
  }
}

console.log("=== Startup Auto-Migration Tests ===\n");

// Clear any inherited flag so the default ("on") path is exercised deterministically.
delete process.env.TINA4_AUTO_MIGRATE;

await (async () => {
  // --- Case 1: dir + .sql + flag on (default) → applied ---
  console.log("--- Case 1: applies pending migrations (default on) ---");
  {
    const base = await freshProject();
    writeMigration(base, "000001_create_widgets.sql",
      "CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT);");
    let threw = false;
    try {
      await autoMigrateOnStartup("migrations", base);
    } catch {
      threw = true;
    }
    assert("did not throw", !threw);
    assert("widgets table created", tableExists("widgets"));
    assert("tracking table created", tableExists("tina4_migration"));
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }

  // --- Case 2: flag off → skipped (no table) ---
  console.log("\n--- Case 2: TINA4_AUTO_MIGRATE off → skipped ---");
  for (const val of ["false", "0", "no", "off"]) {
    const base = await freshProject();
    writeMigration(base, "000001_create_gadgets.sql",
      "CREATE TABLE gadgets (id INTEGER PRIMARY KEY);");
    process.env.TINA4_AUTO_MIGRATE = val;
    await autoMigrateOnStartup("migrations", base);
    assert(`flag="${val}" → gadgets NOT created`, !tableExists("gadgets"));
    delete process.env.TINA4_AUTO_MIGRATE;
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }

  // --- Case 3: no migrations/ dir → silent no-op ---
  console.log("\n--- Case 3: no migrations/ dir → silent no-op ---");
  {
    const base = await freshProject();
    let threw = false;
    try {
      await autoMigrateOnStartup("migrations", base); // dir does not exist
    } catch {
      threw = true;
    }
    assert("no-op did not throw", !threw);
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }

  // --- Case 4: failing migration → logged, NEVER re-raised ---
  console.log("\n--- Case 4: failing migration is non-breaking ---");
  {
    const base = await freshProject();
    writeMigration(base, "000001_broken.sql",
      "CREATE TABLE oops (id INTEGER PRIMARY KEY); THIS IS NOT VALID SQL;");
    let threw = false;
    try {
      await autoMigrateOnStartup("migrations", base);
    } catch {
      threw = true;
    }
    assert("failing migration did NOT throw out of startup hook", !threw);
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
})();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
