/**
 * CLI command: migrate — Run pending SQL migration files.
 *
 * Scans the migrations/ directory for .sql files, executes them in order,
 * and records each as applied via the ORM migration tracker.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export async function runMigrations(migrationDir?: string): Promise<void> {
  const dir = resolve(migrationDir ?? "migrations");

  if (!existsSync(dir)) {
    console.log("  No migrations/ directory found. Nothing to run.");
    return;
  }

  // Initialise the database so the adapter is available
  let initDatabase: typeof import("@tina4/orm").initDatabase;
  let ensureMigrationTable: typeof import("@tina4/orm").ensureMigrationTable;
  let isMigrationApplied: typeof import("@tina4/orm").isMigrationApplied;
  let recordMigration: typeof import("@tina4/orm").recordMigration;
  let getNextBatch: typeof import("@tina4/orm").getNextBatch;
  let getAdapter: typeof import("@tina4/orm").getAdapter;

  try {
    const orm = await import("@tina4/orm");
    initDatabase = orm.initDatabase;
    ensureMigrationTable = orm.ensureMigrationTable;
    isMigrationApplied = orm.isMigrationApplied;
    recordMigration = orm.recordMigration;
    getNextBatch = orm.getNextBatch;
    getAdapter = orm.getAdapter;
  } catch {
    console.error("  Error: @tina4/orm is required to run migrations.");
    process.exit(1);
  }

  // Ensure database is initialised (uses DATABASE_URL or defaults to sqlite)
  try {
    initDatabase();
  } catch {
    // Adapter may already be set — ignore
  }

  ensureMigrationTable();

  // Collect .sql files sorted alphabetically
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("  No .sql migration files found.");
    return;
  }

  const batch = getNextBatch();
  let applied = 0;

  for (const file of files) {
    const name = file.replace(/\.sql$/, "");

    if (isMigrationApplied(name)) {
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
        adapter.execute(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Error in ${file}: ${msg}`);
        process.exit(1);
      }
    }

    recordMigration(name, batch);
    applied++;
  }

  if (applied === 0) {
    console.log("  Nothing to migrate — all migrations already applied.");
  } else {
    console.log(`  Applied ${applied} migration(s) (batch ${batch}).`);
  }
}
