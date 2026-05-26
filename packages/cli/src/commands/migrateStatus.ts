/**
 * CLI command: migrate:status — Show which migrations are applied and which are pending.
 *
 * Usage:
 *   tina4 migrate:status
 *   tina4 migrate:status ./path/to/migrations
 */
import { resolve } from "node:path";
import { loadEnv } from "../../../core/src/dotenv.js";

export async function migrateStatus(migrationDir?: string): Promise<void> {
  // .env must load before initDatabase() so the project's DATABASE_URL is seen.
  loadEnv();

  const dir = resolve(migrationDir ?? "migrations");

  let initDatabase: typeof import("../../../orm/src/index.js").initDatabase;
  let ensureMigrationTable: typeof import("../../../orm/src/index.js").ensureMigrationTable;
  let statusFn: typeof import("../../../orm/src/index.js").status;

  try {
    const orm = await import("../../../orm/src/index.js");
    initDatabase = orm.initDatabase;
    ensureMigrationTable = orm.ensureMigrationTable;
    statusFn = orm.status;
  } catch {
    console.error("  Error: @tina4/orm is required to check migration status.");
    process.exit(1);
  }

  // Ensure database is initialised — MUST await; initDatabase() is async
  // and calls setAdapter() inside. Without await, getAdapter() throws.
  try {
    await initDatabase();
  } catch (err) {
    console.error(`  Error initialising database: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  ensureMigrationTable();

  const result = await statusFn(undefined, { migrationsDir: dir });

  console.log("");
  console.log("  Migration Status");
  console.log("  ─────────────────────────────────────");

  if (result.completed.length === 0 && result.pending.length === 0) {
    console.log("  No migration files found.");
    return;
  }

  if (result.completed.length > 0) {
    console.log(`  Completed (${result.completed.length}):`);
    for (const file of result.completed) {
      console.log(`    [OK] ${file}`);
    }
  }

  if (result.pending.length > 0) {
    console.log(`  Pending (${result.pending.length}):`);
    for (const file of result.pending) {
      console.log(`    [ ] ${file}`);
    }
  }

  console.log("");
}
