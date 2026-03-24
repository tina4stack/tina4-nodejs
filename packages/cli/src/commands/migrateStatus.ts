/**
 * CLI command: migrate:status — Show which migrations are applied and which are pending.
 *
 * Usage:
 *   tina4 migrate:status
 *   tina4 migrate:status ./path/to/migrations
 */
import { resolve } from "node:path";

export async function migrateStatus(migrationDir?: string): Promise<void> {
  const dir = resolve(migrationDir ?? "migrations");

  let initDatabase: typeof import("@tina4/orm").initDatabase;
  let ensureMigrationTable: typeof import("@tina4/orm").ensureMigrationTable;
  let statusFn: typeof import("@tina4/orm").status;

  try {
    const orm = await import("@tina4/orm");
    initDatabase = orm.initDatabase;
    ensureMigrationTable = orm.ensureMigrationTable;
    statusFn = orm.status;
  } catch {
    console.error("  Error: @tina4/orm is required to check migration status.");
    process.exit(1);
  }

  // Ensure database is initialised
  try {
    initDatabase();
  } catch {
    // Adapter may already be set — ignore
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
      console.log(`    ✓ ${file}`);
    }
  }

  if (result.pending.length > 0) {
    console.log(`  Pending (${result.pending.length}):`);
    for (const file of result.pending) {
      console.log(`    ○ ${file}`);
    }
  }

  console.log("");
}
