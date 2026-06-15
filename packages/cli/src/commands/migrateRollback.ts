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
import { loadEnv } from "../../../core/src/dotenv.js";

export async function migrateRollback(migrationDir?: string): Promise<void> {
  // .env must load before initDatabase() — otherwise DATABASE_URL from the
  // project's .env is invisible and we silently fall back to ./data/tina4.db.
  loadEnv();

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

  // Ensure database is initialised — MUST await; initDatabase() is async
  // and calls setAdapter() inside the promise. Without await, the next call
  // to getAdapter() throws "No database adapter configured."
  try {
    await initDatabase();
  } catch (err) {
    console.error(`  Error initialising database: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  await ensureMigrationTable();

  const lastBatch = await getLastBatchMigrations();
  if (lastBatch.length === 0) {
    console.log("  Nothing to rollback — no migrations have been applied.");
    return;
  }

  console.log(`  Rolling back batch ${lastBatch[0].batch} (${lastBatch.length} migration(s))...`);

  const rolledBack = await rollbackFn(dir);

  if (rolledBack.length === 0) {
    console.log("  Nothing was rolled back.");
  } else {
    for (const name of rolledBack) {
      console.log(`    Rolled back: ${name}`);
    }
    console.log(`  Rolled back ${rolledBack.length} migration(s).`);
  }
}
