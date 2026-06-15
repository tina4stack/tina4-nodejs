/**
 * CLI command: migrate — Run pending SQL migration files.
 *
 * Scans the migrations/ directory for .sql files (excluding .down.sql),
 * executes them in order, and records each as applied with a batch number.
 *
 * Supports both naming patterns:
 *   - Sequential: 000001_name.sql
 *   - Timestamp:  YYYYMMDDHHMMSS_name.sql
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnv } from "../../../core/src/dotenv.js";

export async function runMigrations(migrationDir?: string): Promise<void> {
  // Load .env before initialising the DB so DATABASE_URL/TINA4_DATABASE_URL
  // from the project's .env is visible. Without this the migrate command
  // falls back to ./data/tina4.db regardless of what the project configured.
  loadEnv();

  const dir = resolve(migrationDir ?? "migrations");

  if (!existsSync(dir)) {
    console.log("  No migrations/ directory found. Nothing to run.");
    return;
  }

  // Initialise the database so the adapter is available
  let initDatabase: typeof import("../../../orm/src/index.js").initDatabase;
  let ensureMigrationTable: typeof import("../../../orm/src/index.js").ensureMigrationTable;
  let isMigrationApplied: typeof import("../../../orm/src/index.js").isMigrationApplied;
  let recordMigration: typeof import("../../../orm/src/index.js").recordMigration;
  let getNextBatch: typeof import("../../../orm/src/index.js").getNextBatch;
  let getAdapter: typeof import("../../../orm/src/index.js").getAdapter;
  let adapterExecute: typeof import("../../../orm/src/index.js").adapterExecute;

  try {
    const orm = await import("../../../orm/src/index.js");
    initDatabase = orm.initDatabase;
    ensureMigrationTable = orm.ensureMigrationTable;
    isMigrationApplied = orm.isMigrationApplied;
    recordMigration = orm.recordMigration;
    getNextBatch = orm.getNextBatch;
    getAdapter = orm.getAdapter;
    adapterExecute = orm.adapterExecute;
  } catch {
    console.error("  Error: @tina4/orm is required to run migrations.");
    process.exit(1);
  }

  // Ensure database is initialised (uses TINA4_DATABASE_URL/DATABASE_URL or
  // defaults to sqlite). initDatabase() is async — MUST be awaited, otherwise
  // setAdapter() has not run by the time ensureMigrationTable() asks for the
  // adapter and the whole CLI crashes with "No database adapter configured."
  try {
    await initDatabase();
  } catch (err) {
    console.error(`  Error initialising database: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  await ensureMigrationTable();

  // Collect .sql files, excluding .down.sql, sorted by numeric prefix
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort((a, b) => {
      const aMatch = a.match(/^(\d+)/);
      const bMatch = b.match(/^(\d+)/);
      if (aMatch && bMatch) {
        const aNum = BigInt(aMatch[1]);
        const bNum = BigInt(bMatch[1]);
        if (aNum < bNum) return -1;
        if (aNum > bNum) return 1;
      }
      return a.localeCompare(b);
    });

  if (files.length === 0) {
    console.log("  No .sql migration files found.");
    return;
  }

  const batch = await getNextBatch();
  let applied = 0;

  for (const file of files) {
    const name = file.replace(/\.sql$/, "");

    if (await isMigrationApplied(name)) {
      continue;
    }

    const sql = readFileSync(join(dir, file), "utf-8").trim();
    if (!sql) continue;

    console.log(`  Migrating: ${file}`);

    const adapter = getAdapter();
    // Split on semicolons and execute each statement
    const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);

    for (const stmt of statements) {
      try {
        await adapterExecute(adapter, stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Error in ${file}: ${msg}`);
        process.exit(1);
      }
    }

    await recordMigration(name, batch);
    applied++;
  }

  if (applied === 0) {
    console.log("  Nothing to migrate — all migrations already applied.");
  } else {
    console.log(`  Applied ${applied} migration(s) (batch ${batch}).`);
  }
}
