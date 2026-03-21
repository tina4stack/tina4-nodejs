import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FieldDefinition, DatabaseAdapter } from "./types.js";
import type { SQLiteAdapter } from "./adapters/sqlite.js";
import type { DiscoveredModel } from "./model.js";
import { getAdapter } from "./database.js";

/**
 * Sync model definitions to the database (create tables, add columns).
 */
export function syncModels(models: DiscoveredModel[]): void {
  const adapter = getAdapter() as SQLiteAdapter;

  for (const { definition } of models) {
    const { tableName, fields, softDelete } = definition;

    // If softDelete is enabled, ensure is_deleted field exists
    const allFields = { ...fields };
    if (softDelete && !allFields.is_deleted) {
      allFields.is_deleted = {
        type: "integer",
        default: 0,
      };
    }

    if (!adapter.tableExists(tableName)) {
      adapter.createTable(tableName, allFields);
      console.log(`    Created table: ${tableName}`);
    } else {
      // Check for new columns
      const existing = adapter.getTableColumns(tableName);
      const existingNames = new Set(existing.map((c) => c.name));

      for (const [colName, def] of Object.entries(allFields)) {
        if (!existingNames.has(colName)) {
          adapter.addColumn(tableName, colName, def);
          console.log(`    Added column: ${tableName}.${colName}`);
        }
      }
    }
  }
}

/**
 * Migration tracking table name.
 */
const MIGRATION_TABLE = "tina4_migration";

/**
 * Ensure the migration tracking table exists.
 */
export function ensureMigrationTable(): void {
  const adapter = getAdapter() as SQLiteAdapter;
  if (!adapter.tableExists(MIGRATION_TABLE)) {
    adapter.createTable(MIGRATION_TABLE, {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "string", required: true },
      batch: { type: "integer", required: true },
      applied_at: { type: "datetime", default: "now" },
    });
  }
}

/**
 * Get the current batch number (max batch + 1).
 */
export function getNextBatch(): number {
  const adapter = getAdapter();
  const rows = adapter.query<{ max_batch: number | null }>(
    `SELECT MAX(batch) as max_batch FROM "${MIGRATION_TABLE}"`,
  );
  return (rows[0]?.max_batch ?? 0) + 1;
}

/**
 * Check if a migration has already been applied.
 */
export function isMigrationApplied(name: string): boolean {
  const adapter = getAdapter();
  const rows = adapter.query(
    `SELECT id FROM "${MIGRATION_TABLE}" WHERE name = ?`,
    [name],
  );
  return rows.length > 0;
}

/**
 * Record a migration as applied.
 */
export function recordMigration(name: string, batch: number): void {
  const adapter = getAdapter();
  adapter.execute(
    `INSERT INTO "${MIGRATION_TABLE}" (name, batch) VALUES (?, ?)`,
    [name, batch],
  );
}

/**
 * Apply a migration (run its up function and record it).
 */
export function applyMigration(
  name: string,
  up: () => void,
  batch: number,
): void {
  if (isMigrationApplied(name)) {
    return;
  }
  up();
  recordMigration(name, batch);
}

/**
 * Get all migrations from the last batch.
 */
export function getLastBatchMigrations(): Array<{ id: number; name: string; batch: number }> {
  const adapter = getAdapter();
  const rows = adapter.query<{ max_batch: number | null }>(
    `SELECT MAX(batch) as max_batch FROM "${MIGRATION_TABLE}"`,
  );
  const lastBatch = rows[0]?.max_batch;
  if (lastBatch === null || lastBatch === undefined) return [];

  return adapter.query<{ id: number; name: string; batch: number }>(
    `SELECT id, name, batch FROM "${MIGRATION_TABLE}" WHERE batch = ? ORDER BY id DESC`,
    [lastBatch],
  );
}

/**
 * Remove a migration record (used during rollback).
 */
export function removeMigrationRecord(name: string): void {
  const adapter = getAdapter();
  adapter.execute(
    `DELETE FROM "${MIGRATION_TABLE}" WHERE name = ?`,
    [name],
  );
}

/**
 * Rollback the last batch of migrations.
 * Expects a map of migration name -> down function.
 */
export function rollback(
  downFunctions: Map<string, () => void>,
): string[] {
  const migrations = getLastBatchMigrations();
  const rolledBack: string[] = [];

  for (const migration of migrations) {
    const down = downFunctions.get(migration.name);
    if (down) {
      down();
    }
    removeMigrationRecord(migration.name);
    rolledBack.push(migration.name);
  }

  return rolledBack;
}

/**
 * Get all applied migrations.
 */
export function getAppliedMigrations(): Array<{ id: number; name: string; batch: number; applied_at: string }> {
  const adapter = getAdapter();
  return adapter.query<{ id: number; name: string; batch: number; applied_at: string }>(
    `SELECT * FROM "${MIGRATION_TABLE}" ORDER BY id ASC`,
  );
}

// ---------------------------------------------------------------------------
// SQL-file-based migration system (matches Python's tina4_python.migration API)
// ---------------------------------------------------------------------------

/**
 * Result returned by the `migrate()` function.
 */
export interface MigrationResult {
  /** Filenames of successfully applied migrations. */
  applied: string[];
  /** Filenames that were already applied (skipped). */
  skipped: string[];
  /** Filenames that failed with error details. */
  failed: string[];
}

/**
 * Split SQL text into individual statements on the given delimiter.
 *
 * Strips line comments (`-- ...`) and block comments, handles stored
 * procedure blocks delimited by `$$` or `//`.
 */
function splitStatements(sql: string, delimiter = ";"): string[] {
  // Extract blocks delimited by $$ or // first, replacing with placeholders
  const blocks: string[] = [];
  const saveBlock = (_match: string, _p1: string): string => {
    blocks.push(_match);
    return `__BLOCK_${blocks.length - 1}__`;
  };

  let processed = sql.replace(/\$\$([\s\S]*?)\$\$/g, saveBlock);
  processed = processed.replace(/\/\/([\s\S]*?)\/\//g, saveBlock);

  // Remove block comments (/* ... */)
  const clean = processed.replace(/\/\*[\s\S]*?\*\//g, "");

  const statements: string[] = [];
  for (const part of clean.split(delimiter)) {
    const lines: string[] = [];
    for (const line of part.split("\n")) {
      const stripped = line.trim();
      if (!stripped || stripped.startsWith("--")) continue;
      // Remove inline comments
      const commentPos = line.indexOf("--");
      lines.push(commentPos >= 0 ? line.slice(0, commentPos) : line);
    }
    let cleaned = lines.join("\n").trim();

    // Restore block placeholders
    for (let i = 0; i < blocks.length; i++) {
      cleaned = cleaned.replace(`__BLOCK_${i}__`, blocks[i]);
    }

    if (cleaned) statements.push(cleaned);
  }
  return statements;
}

/**
 * Run all pending SQL-file migrations.
 *
 * Matches the Python `migrate(db, migration_folder, delimiter)` API.
 *
 * 1. Creates the `tina4_migration` tracking table if it doesn't exist.
 * 2. Scans `migrationsDir` for `NNNNNN_description.sql` files (sorted).
 * 3. Skips files already recorded as applied.
 * 4. Splits file content on `delimiter` and executes each statement.
 * 5. On success records the migration; on error logs and continues.
 * 6. Returns a summary of applied / skipped / failed files.
 *
 * @param adapter - A DatabaseAdapter instance (or omit to use the global adapter).
 * @param options - Optional configuration.
 */
export async function migrate(
  adapter?: DatabaseAdapter,
  options?: { migrationsDir?: string; delimiter?: string },
): Promise<MigrationResult> {
  const db = adapter ?? getAdapter();
  const dir = resolve(options?.migrationsDir ?? "migrations");
  const delimiter = options?.delimiter ?? ";";

  const result: MigrationResult = { applied: [], skipped: [], failed: [] };

  if (!existsSync(dir)) {
    return result;
  }

  // Ensure tracking table
  if (!db.tableExists(MIGRATION_TABLE)) {
    db.execute(`CREATE TABLE IF NOT EXISTS "${MIGRATION_TABLE}" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      content TEXT,
      passed INTEGER NOT NULL DEFAULT 0,
      run_at TEXT NOT NULL
    )`);
  }

  // Collect .sql files (exclude .down.sql), sorted alphabetically
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort();

  if (files.length === 0) return result;

  for (const file of files) {
    const migrationId = file.replace(/\.sql$/, "");

    // Check if already applied (passed = 1)
    const existing = db.query<{ id: number; passed: number }>(
      `SELECT id, passed FROM "${MIGRATION_TABLE}" WHERE description = ?`,
      [migrationId],
    );

    if (existing.length > 0 && existing[0].passed === 1) {
      result.skipped.push(file);
      continue;
    }

    // If there's a failed record (passed = 0), remove it so we can retry
    if (existing.length > 0 && existing[0].passed === 0) {
      db.execute(
        `DELETE FROM "${MIGRATION_TABLE}" WHERE description = ?`,
        [migrationId],
      );
    }

    const sqlContent = readFileSync(join(dir, file), "utf-8").trim();
    if (!sqlContent) {
      result.skipped.push(file);
      continue;
    }

    const statements = splitStatements(sqlContent, delimiter);

    try {
      db.startTransaction();

      for (const stmt of statements) {
        db.execute(stmt);
      }

      // Record as passed
      const now = new Date().toISOString();
      db.execute(
        `INSERT INTO "${MIGRATION_TABLE}" (description, content, passed, run_at) VALUES (?, ?, 1, ?)`,
        [migrationId, sqlContent, now],
      );

      db.commit();
      result.applied.push(file);
    } catch (err) {
      try {
        db.rollback();
      } catch {
        // rollback may fail if transaction was auto-rolled-back
      }

      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Migration failed: ${file} — ${msg}`);
      result.failed.push(file);
      // Continue to next file (matching Python behaviour)
    }
  }

  return result;
}

/**
 * Create a new empty SQL migration file with the next sequence number.
 *
 * Matches the Python `create_migration(description, migration_folder)` API.
 *
 * @param description - Human-readable description (used in filename).
 * @param options - Optional configuration.
 * @returns The absolute path to the created file.
 */
export async function createMigration(
  description: string,
  options?: { migrationsDir?: string },
): Promise<string> {
  const dir = resolve(options?.migrationsDir ?? "migrations");

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Determine next sequence number
  const existing = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
        .sort()
    : [];

  let nextSeq = 1;
  if (existing.length > 0) {
    const last = existing[existing.length - 1];
    const match = last.match(/^(\d+)/);
    if (match) {
      nextSeq = parseInt(match[1], 10) + 1;
    }
  }

  // Sanitise description for filename
  const safeName = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  const seqStr = String(nextSeq).padStart(6, "0");
  const fileName = `${seqStr}_${safeName}.sql`;
  const filePath = join(dir, fileName);

  const template = `-- Migration: ${description}\n-- Created: ${new Date().toISOString()}\n\n`;

  writeFileSync(filePath, template, "utf-8");

  return filePath;
}
