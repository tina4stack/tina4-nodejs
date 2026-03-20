import type { FieldDefinition } from "./types.js";
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
const MIGRATION_TABLE = "_tina4_migrations";

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
