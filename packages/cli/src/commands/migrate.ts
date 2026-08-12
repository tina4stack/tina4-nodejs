/**
 * CLI command: migrate — Run pending SQL migration files.
 *
 * MIG-NODE-CLI-DIVERGENT (feature 15, MIG-DEC-01): this used to be a SECOND,
 * weaker migration implementation -- a naive `sql.split(";")` (breaks on a
 * `;` inside a string/comment/proc block), no per-file transaction (a
 * mid-file failure left earlier statements applied on every engine
 * including PostgreSQL, with no rollback), no Firebird/MSSQL idempotency
 * skips, and the ledger row recorded OUTSIDE any transaction. All untested.
 *
 * It now delegates to the SAME `migrate()` the ORM's programmatic API uses
 * (`packages/orm/src/migration.ts`) -- ONE code path, so the CLI gets the
 * transactional, robust-split, idempotent behaviour for free. The weaker
 * re-implementation is deleted, not kept alongside (maintainability = less
 * code).
 *
 * Supports both naming patterns:
 *   - Sequential: 000001_name.sql
 *   - Timestamp:  YYYYMMDDHHMMSS_name.sql
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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

  let initDatabase: typeof import("../../../orm/src/index.js").initDatabase;
  let migrate: typeof import("../../../orm/src/index.js").migrate;

  try {
    const orm = await import("../../../orm/src/index.js");
    initDatabase = orm.initDatabase;
    migrate = orm.migrate;
  } catch {
    console.error("  Error: @tina4/orm is required to run migrations.");
    process.exit(1);
  }

  // Initialise the database so the adapter is available. initDatabase() is
  // async — MUST be awaited, otherwise setAdapter() has not run by the time
  // migrate() asks for the adapter and the whole CLI crashes with
  // "No database adapter configured."
  try {
    await initDatabase();
  } catch (err) {
    console.error(`  Error initialising database: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const result = await migrate(undefined, { migrationsDir: dir });

  if (result.applied.length === 0 && result.failed.length === 0) {
    console.log("  Nothing to migrate — all migrations already applied.");
  } else {
    for (const file of result.applied) {
      console.log(`  Migrated: ${file}`);
    }
    if (result.applied.length > 0) {
      console.log(`  Applied ${result.applied.length} migration(s).`);
    }
  }

  if (result.failed.length > 0) {
    // migrate() has already logged the specific statement error for each
    // failed file (console.error + Log.error) -- fail-fast so CI/CD actually
    // fails when a migration breaks, matching the explicit `tina4 migrate`
    // CLI contract in every other framework (the startup auto-migrate hook
    // is the one that swallows; this command must not).
    console.error(`  ${result.failed.length} migration(s) failed: ${result.failed.join(", ")}`);
    process.exit(1);
  }
}
