/**
 * CLI command: migrate:rollback — Roll back the last batch of migrations.
 *
 * Looks for .down.sql files corresponding to each migration in the last batch,
 * executes the SQL, and removes the tracking records.
 *
 * Usage:
 *   tina4 migrate:rollback
 *   tina4 migrate:rollback ./path/to/migrations
 */
import { resolve } from "node:path";

export async function migrateRollback(migrationDir?: string): Promise<void> {
  const dir = resolve(migrationDir ?? "migrations");

  let initDatabase: typeof import("../../../orm/src/index.js").initDatabase;
  let ensureMigrationTable: typeof import("../../../orm/src/index.js").ensureMigrationTable;
  let rollbackFn: typeof import("../../../orm/src/index.js").rollback;
  let getLastBatchMigrations: typeof import("../../../orm/src/index.js").getLastBatchMigrations;

  try {
    const orm = await import("../../../orm/src/index.js");
    initDatabase = orm.initDatabase;
    ensureMigrationTable = orm.ensureMigrationTable;
    rollbackFn = orm.rollback;
    getLastBatchMigrations = orm.getLastBatchMigrations;
  } catch {
    console.error("  Error: @tina4/orm is required to rollback migrations.");
    process.exit(1);
  }

  // Ensure database is initialised
  try {
    initDatabase();
  } catch {
    // Adapter may already be set — ignore
  }

  ensureMigrationTable();

  const lastBatch = getLastBatchMigrations();
  if (lastBatch.length === 0) {
    console.log("  Nothing to rollback — no migrations have been applied.");
    return;
  }

  console.log(`  Rolling back batch ${lastBatch[0].batch} (${lastBatch.length} migration(s))...`);

  const rolledBack = rollbackFn(dir);

  if (rolledBack.length === 0) {
    console.log("  Nothing was rolled back.");
  } else {
    for (const name of rolledBack) {
      console.log(`    Rolled back: ${name}`);
    }
    console.log(`  Rolled back ${rolledBack.length} migration(s).`);
  }
}
