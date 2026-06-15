import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FieldDefinition, DatabaseAdapter } from "./types.js";
import type { SQLiteAdapter } from "./adapters/sqlite.js";
import type { DiscoveredModel } from "./model.js";
import {
  getAdapter,
  adapterQuery, adapterExecute, adapterTableExists,
  adapterCreateTable, adapterColumns,
  adapterStartTransaction, adapterCommit, adapterRollback,
} from "./database.js";

// ---------------------------------------------------------------------------
// Firebird ALTER TABLE ADD idempotency check
// ---------------------------------------------------------------------------
// Firebird does not support IF NOT EXISTS for ALTER TABLE ADD. When a migration
// adds a column that already exists, Firebird throws an error and blocks the
// entire migration. These helpers detect ALTER TABLE ... ADD statements and
// query RDB$RELATION_FIELDS to see if the column is already present. If so,
// the statement is silently skipped rather than executed.

/**
 * Regex to match ALTER TABLE <table> ADD <column> ...
 * Captures table name and column name (quoted or unquoted).
 */
const ALTER_ADD_RE =
  /^\s*ALTER\s+TABLE\s+(?:"([^"]+)"|(\S+))\s+ADD\s+(?:"([^"]+)"|(\S+))/i;

/**
 * Check if the adapter is a Firebird adapter (duck-type check).
 * We look for the `queryAsync` method and `translateSql` which are
 * unique to the Firebird adapter.
 */
function isFirebirdAdapter(db: DatabaseAdapter): boolean {
  return (
    typeof (db as any).queryAsync === "function" &&
    typeof (db as any).translateSql === "function"
  );
}

/**
 * Check if a column already exists in a Firebird table.
 */
async function firebirdColumnExists(
  db: DatabaseAdapter,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await (db as any).queryAsync<Record<string, unknown>>(
    "SELECT 1 FROM RDB$RELATION_FIELDS WHERE RDB$RELATION_NAME = ? AND TRIM(RDB$FIELD_NAME) = ?",
    [table.toUpperCase(), column.toUpperCase()],
  );
  return rows.length > 0;
}

/**
 * If stmt is an ALTER TABLE ... ADD on Firebird and the column already exists,
 * returns a skip reason string. Returns null if the statement should execute normally.
 */
async function shouldSkipForFirebird(
  db: DatabaseAdapter,
  stmt: string,
): Promise<string | null> {
  if (!isFirebirdAdapter(db)) return null;

  const m = stmt.match(ALTER_ADD_RE);
  if (!m) return null;

  const table = m[1] ?? m[2];
  const column = m[3] ?? m[4];

  if (await firebirdColumnExists(db, table, column)) {
    return `Column ${column} already exists in ${table}, skipping`;
  }

  return null;
}

/**
 * Sync model definitions to the database (create tables, add columns).
 */
export async function syncModels(models: DiscoveredModel[]): Promise<void> {
  const adapter = getAdapter();

  for (const { definition } of models) {
    const { tableName, fields, softDelete, fieldMapping } = definition;
    const mapping = fieldMapping ?? {};

    // Helper to get DB column name for a JS property name
    const getDbCol = (prop: string): string => mapping[prop] ?? prop;

    // If softDelete is enabled, ensure is_deleted field exists
    const allFields = { ...fields };
    if (softDelete && !allFields.is_deleted) {
      allFields.is_deleted = {
        type: "integer",
        default: 0,
      };
    }

    // Remap field keys to DB column names for table creation/migration
    const dbFields: Record<string, typeof allFields[string]> = {};
    for (const [fieldName, def] of Object.entries(allFields)) {
      const dbCol = getDbCol(fieldName);
      dbFields[dbCol] = def;
    }

    if (!(await adapterTableExists(adapter, tableName))) {
      // adapterCreateTable prefers createTableAsync — engine-aware DDL on
      // PostgreSQL/MySQL/MSSQL/Firebird (TIMESTAMP/BOOLEAN/SERIAL etc.).
      await adapterCreateTable(adapter, tableName, dbFields);
      console.log(`    Created table: ${tableName}`);
    } else {
      // Check for new columns. SQLite exposes the legacy getTableColumns/
      // addColumn helpers; other engines use columns()/ALTER TABLE.
      const existingCols = (adapter as any).getTableColumns
        ? (adapter as SQLiteAdapter).getTableColumns(tableName)
        : await adapterColumns(adapter, tableName);
      const existingNames = new Set(existingCols.map((c) => c.name.toLowerCase()));

      for (const [colName, def] of Object.entries(dbFields)) {
        if (!existingNames.has(colName.toLowerCase())) {
          if ((adapter as any).addColumn) {
            (adapter as any).addColumn(tableName, colName, def);
          } else {
            await adapterExecute(adapter, buildAddColumnSql(adapter, tableName, colName, def));
          }
          console.log(`    Added column: ${tableName}.${colName}`);
        }
      }
    }
  }
}

/**
 * Build an engine-aware `ALTER TABLE ... ADD COLUMN` statement for adapters
 * that don't expose the SQLite-style addColumn() helper.
 */
function buildAddColumnSql(
  adapter: DatabaseAdapter,
  table: string,
  colName: string,
  def: FieldDefinition,
): string {
  const engine = adapter.constructor.name;
  const isPg = engine === "PostgresAdapter";
  const typeMap: Record<string, string> = isPg
    ? { integer: "INTEGER", string: def.maxLength ? `VARCHAR(${def.maxLength})` : "VARCHAR(255)", text: "TEXT", number: "DOUBLE PRECISION", numeric: "DOUBLE PRECISION", boolean: "BOOLEAN", datetime: "TIMESTAMP" }
    : { integer: "INTEGER", string: def.maxLength ? `VARCHAR(${def.maxLength})` : "VARCHAR(255)", text: "TEXT", number: "DOUBLE PRECISION", numeric: "DOUBLE PRECISION", boolean: "INTEGER", datetime: "TIMESTAMP" };
  const sqlType = typeMap[def.type] ?? "TEXT";
  let sql = `ALTER TABLE "${table}" ADD COLUMN "${colName}" ${sqlType}`;
  if (def.default !== undefined && def.default !== "now") {
    const dv =
      typeof def.default === "string" ? `'${def.default}'`
      : typeof def.default === "boolean" ? (isPg ? (def.default ? "TRUE" : "FALSE") : (def.default ? "1" : "0"))
      : String(def.default);
    sql += ` DEFAULT ${dv}`;
  } else if (def.default === "now") {
    sql += " DEFAULT CURRENT_TIMESTAMP";
  }
  return sql;
}

/**
 * Migration tracking table name.
 */
const MIGRATION_TABLE = "tina4_migration";

/**
 * Ensure the migration tracking table exists with batch support.
 */
export async function ensureMigrationTable(): Promise<void> {
  const adapter = getAdapter();
  if (!(await adapterTableExists(adapter, MIGRATION_TABLE))) {
    if (isFirebirdAdapter(adapter)) {
      // Firebird: no AUTOINCREMENT, no TEXT type, use generator for IDs
      try {
        await adapterExecute(adapter, "CREATE GENERATOR GEN_TINA4_MIGRATION_ID");
        try { await adapterExecute(adapter, "COMMIT"); } catch { /* ignore */ }
      } catch {
        // Generator may already exist
      }
      await adapterExecute(adapter, `CREATE TABLE "${MIGRATION_TABLE}" (
        id INTEGER NOT NULL PRIMARY KEY,
        name VARCHAR(500) NOT NULL,
        batch INTEGER NOT NULL DEFAULT 1,
        applied_at VARCHAR(50) NOT NULL
      )`);
    } else {
      await adapterCreateTable(adapter, MIGRATION_TABLE, {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        name: { type: "string", required: true },
        batch: { type: "integer", required: true },
        applied_at: { type: "datetime", default: "now" },
      });
    }
  } else {
    // Ensure batch column exists on older tables that only had passed/description
    try {
      const cols = (adapter as any).getTableColumns
        ? (adapter as SQLiteAdapter).getTableColumns(MIGRATION_TABLE)
        : await adapterColumns(adapter, MIGRATION_TABLE);
      const colNames = new Set(cols.map((c) => c.name.toLowerCase()));
      if (!colNames.has("batch")) {
        await adapterExecute(adapter, `ALTER TABLE "${MIGRATION_TABLE}" ADD COLUMN batch INTEGER NOT NULL DEFAULT 1`);
      }
    } catch {
      // ignore — column may already exist
    }
  }
}

/**
 * Get the current batch number (max batch + 1).
 */
export async function getNextBatch(): Promise<number> {
  const adapter = getAdapter();
  const rows = await adapterQuery<{ max_batch: number | null }>(adapter,
    `SELECT MAX(batch) as max_batch FROM "${MIGRATION_TABLE}"`,
  );
  return (rows[0]?.max_batch ?? 0) + 1;
}

/**
 * Check if a migration has already been applied.
 */
export async function isMigrationApplied(name: string): Promise<boolean> {
  const adapter = getAdapter();
  const rows = await adapterQuery(adapter,
    `SELECT id FROM "${MIGRATION_TABLE}" WHERE name = ?`,
    [name],
  );
  return rows.length > 0;
}

/**
 * Record a migration as applied.
 */
export async function recordMigration(name: string, batch: number, passed: number = 1): Promise<void> {
  const adapter = getAdapter();
  if (isFirebirdAdapter(adapter)) {
    // Firebird: generate ID from sequence
    const rows = await adapterQuery<{ NEXT_ID: number }>(adapter,
      "SELECT GEN_ID(GEN_TINA4_MIGRATION_ID, 1) AS NEXT_ID FROM RDB$DATABASE",
    );
    const nextId = rows[0]?.NEXT_ID ?? 1;
    await adapterExecute(adapter,
      `INSERT INTO "${MIGRATION_TABLE}" (id, name, batch) VALUES (?, ?, ?)`,
      [nextId, name, batch],
    );
  } else {
    await adapterExecute(adapter,
      `INSERT INTO "${MIGRATION_TABLE}" (name, batch) VALUES (?, ?)`,
      [name, batch],
    );
  }
}

/**
 * Apply a migration (run its up function and record it).
 */
export async function applyMigration(
  name: string,
  up: () => void | Promise<void>,
  batch: number,
): Promise<void> {
  if (await isMigrationApplied(name)) {
    return;
  }
  await up();
  await recordMigration(name, batch);
}

/**
 * Get all migrations from the last batch.
 */
export async function getLastBatchMigrations(): Promise<Array<{ id: number; name: string; batch: number }>> {
  const adapter = getAdapter();
  const rows = await adapterQuery<{ max_batch: number | null }>(adapter,
    `SELECT MAX(batch) as max_batch FROM "${MIGRATION_TABLE}"`,
  );
  const lastBatch = rows[0]?.max_batch;
  if (lastBatch === null || lastBatch === undefined) return [];

  return adapterQuery<{ id: number; name: string; batch: number }>(adapter,
    `SELECT id, name, batch FROM "${MIGRATION_TABLE}" WHERE batch = ? ORDER BY id DESC`,
    [lastBatch],
  );
}

/**
 * Remove a migration record (used during rollback).
 */
export async function removeMigrationRecord(name: string): Promise<void> {
  const adapter = getAdapter();
  await adapterExecute(adapter,
    `DELETE FROM "${MIGRATION_TABLE}" WHERE name = ?`,
    [name],
  );
}

/**
 * Rollback the last batch of migrations using .down.sql files.
 *
 * For each migration in the last batch (in reverse order):
 * 1. Looks for a corresponding .down.sql file on disk
 * 2. If found, reads and executes the SQL statements
 * 3. If not found, logs a warning
 * 4. Deletes the tracking record either way
 *
 * @param migrationsDir - Directory containing migration files (default: "migrations")
 * @param delimiter - SQL statement delimiter (default: ";")
 * @returns Array of rolled-back migration names
 */
export async function rollback(
  migrationsDir?: string | Map<string, () => void | Promise<void>>,
  delimiter?: string,
): Promise<string[]> {
  // Handle legacy API: if first arg is a Map, use old behaviour
  if (migrationsDir instanceof Map) {
    const downFunctions = migrationsDir;
    const migrations = await getLastBatchMigrations();
    const rolledBack: string[] = [];
    for (const migration of migrations) {
      const down = downFunctions.get(migration.name);
      if (down) {
        await down();
      }
      await removeMigrationRecord(migration.name);
      rolledBack.push(migration.name);
    }
    return rolledBack;
  }

  const dir = resolve(migrationsDir ?? "migrations");
  const delim = delimiter ?? ";";
  const db = getAdapter();
  const migrations = await getLastBatchMigrations();
  const rolledBack: string[] = [];

  for (const migration of migrations) {
    // Determine the .down.sql filename
    const downFile = `${migration.name}.down.sql`;
    const downPath = join(dir, downFile);

    if (existsSync(downPath)) {
      const sqlContent = readFileSync(downPath, "utf-8").trim();
      if (sqlContent) {
        const statements = splitStatements(sqlContent, delim);
        try {
          await adapterStartTransaction(db);
          for (const stmt of statements) {
            await adapterExecute(db, stmt);
          }
          await adapterCommit(db);
        } catch (err) {
          try {
            await adapterRollback(db);
          } catch {
            // rollback may fail if auto-rolled-back
          }
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  Rollback failed for ${migration.name}: ${msg}`);
          // Still remove the record so the migration can be re-applied
        }
      }
    } else {
      console.warn(`  Warning: No .down.sql file found for ${migration.name} — skipping SQL execution`);
    }

    await removeMigrationRecord(migration.name);
    rolledBack.push(migration.name);
  }

  return rolledBack;
}

/**
 * Get all applied migrations.
 */
export async function getAppliedMigrations(): Promise<Array<{ id: number; name: string; batch: number; applied_at: string }>> {
  const adapter = getAdapter();
  return adapterQuery<{ id: number; name: string; batch: number; applied_at: string }>(adapter,
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
 * Result returned by the `status()` function.
 */
export interface MigrationStatus {
  /** Filenames of completed (already applied) migrations. */
  completed: string[];
  /** Filenames of pending (not yet applied) migrations. */
  pending: string[];
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
 * Sort migration filenames supporting both naming patterns:
 * - Sequential: 000001_name.sql, 000002_name.sql
 * - Timestamp: 20240315120000_name.sql (YYYYMMDDHHMMSS)
 *
 * Both patterns start with digits followed by underscore, so alphabetical
 * sort works correctly for both (zero-padded sequential and timestamp).
 */
function sortMigrationFiles(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const aPrefix = a.match(/^(\d+)/);
    const bPrefix = b.match(/^(\d+)/);
    if (aPrefix && bPrefix) {
      // Compare numeric prefixes — handles both 000001 and 20240315120000
      const aNum = BigInt(aPrefix[1]);
      const bNum = BigInt(bPrefix[1]);
      if (aNum < bNum) return -1;
      if (aNum > bNum) return 1;
      return a.localeCompare(b);
    }
    return a.localeCompare(b);
  });
}

/**
 * Run all pending SQL-file migrations.
 *
 * Supports both naming patterns:
 * - Sequential: 000001_description.sql
 * - Timestamp: YYYYMMDDHHMMSS_description.sql
 *
 * 1. Creates the `tina4_migration` tracking table if it doesn't exist.
 * 2. Scans `migrationsDir` for `.sql` files (excluding `.down.sql`), sorted.
 * 3. Skips files already recorded as applied.
 * 4. Splits file content on `delimiter` and executes each statement.
 * 5. On success records the migration with the current batch number.
 * 6. On error logs and continues.
 * 7. Returns a summary of applied / skipped / failed files.
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

  // Ensure tracking table with batch support
  if (!(await adapterTableExists(db, MIGRATION_TABLE))) {
    if (isFirebirdAdapter(db)) {
      // Firebird: no AUTOINCREMENT, no TEXT type, use generator for IDs
      try {
        await adapterExecute(db, "CREATE GENERATOR GEN_TINA4_MIGRATION_ID");
        try { await adapterExecute(db, "COMMIT"); } catch { /* ignore */ }
      } catch {
        // Generator may already exist
      }
      await adapterExecute(db, `CREATE TABLE "${MIGRATION_TABLE}" (
        id INTEGER NOT NULL PRIMARY KEY,
        name VARCHAR(500) NOT NULL,
        batch INTEGER NOT NULL DEFAULT 1,
        applied_at VARCHAR(50) NOT NULL
      )`);
    } else if (db.constructor.name === "PostgresAdapter") {
      // PostgreSQL: SERIAL + TIMESTAMP (not AUTOINCREMENT/TEXT).
      await adapterExecute(db, `CREATE TABLE IF NOT EXISTS "${MIGRATION_TABLE}" (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        batch INTEGER NOT NULL DEFAULT 1,
        applied_at TEXT NOT NULL
      )`);
    } else {
      await adapterExecute(db, `CREATE TABLE IF NOT EXISTS "${MIGRATION_TABLE}" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        batch INTEGER NOT NULL DEFAULT 1,
        applied_at TEXT NOT NULL
      )`);
    }
  } else {
    // Migrate old schema: if table has 'description' + 'passed' columns, migrate data
    try {
      await adapterQuery<Record<string, unknown>>(db,
        `SELECT * FROM "${MIGRATION_TABLE}" LIMIT 0`,
      );
      // Check column names by querying pragma or just try adding batch
    } catch {
      // ignore
    }
  }

  // Collect .sql files (exclude .down.sql), sorted by prefix
  const files = sortMigrationFiles(
    readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")),
  );

  if (files.length === 0) return result;

  // Determine the batch number for this run
  let currentBatch = 1;
  try {
    const batchRows = await adapterQuery<{ max_batch: number | null }>(db,
      `SELECT MAX(batch) as max_batch FROM "${MIGRATION_TABLE}"`,
    );
    currentBatch = (batchRows[0]?.max_batch ?? 0) + 1;
  } catch {
    // Table may have old schema without batch column
    currentBatch = 1;
  }

  for (const file of files) {
    const migrationId = file.replace(/\.sql$/, "");

    // Check if already applied — support both 'name' and legacy 'description' column
    let alreadyApplied = false;
    try {
      const existing = await adapterQuery<{ id: number }>(db,
        `SELECT id FROM "${MIGRATION_TABLE}" WHERE name = ?`,
        [migrationId],
      );
      alreadyApplied = existing.length > 0;
    } catch {
      // Might be old schema with 'description' column instead of 'name'
      try {
        const existing = await adapterQuery<{ id: number; passed: number }>(db,
          `SELECT id, passed FROM "${MIGRATION_TABLE}" WHERE description = ?`,
          [migrationId],
        );
        if (existing.length > 0 && existing[0].passed === 1) {
          alreadyApplied = true;
        } else if (existing.length > 0 && existing[0].passed === 0) {
          // Failed record from old schema — remove to retry
          await adapterExecute(db,
            `DELETE FROM "${MIGRATION_TABLE}" WHERE description = ?`,
            [migrationId],
          );
        }
      } catch {
        // Neither column exists — continue
      }
    }

    if (alreadyApplied) {
      result.skipped.push(file);
      continue;
    }

    const sqlContent = readFileSync(join(dir, file), "utf-8").trim();
    if (!sqlContent) {
      result.skipped.push(file);
      continue;
    }

    const statements = splitStatements(sqlContent, delimiter);

    try {
      await adapterStartTransaction(db);

      for (const stmt of statements) {
        // Firebird lacks IF NOT EXISTS for ALTER TABLE ADD.
        // Pre-check the system catalogue so duplicate columns are
        // silently skipped instead of raising an error.
        const skipReason = await shouldSkipForFirebird(db, stmt);
        if (skipReason) {
          console.log(`  Migration ${file}: ${skipReason}`);
          continue;
        }
        await adapterExecute(db, stmt);
      }

      // Record as applied with batch number
      const now = new Date().toISOString();
      try {
        if (isFirebirdAdapter(db)) {
          // Firebird: generate ID from sequence
          const idRows = await adapterQuery<{ NEXT_ID: number }>(db,
            "SELECT GEN_ID(GEN_TINA4_MIGRATION_ID, 1) AS NEXT_ID FROM RDB$DATABASE",
          );
          const nextId = idRows[0]?.NEXT_ID ?? 1;
          await adapterExecute(db,
            `INSERT INTO "${MIGRATION_TABLE}" (id, name, batch, applied_at) VALUES (?, ?, ?, ?)`,
            [nextId, migrationId, currentBatch, now],
          );
        } else {
          await adapterExecute(db,
            `INSERT INTO "${MIGRATION_TABLE}" (name, batch, applied_at) VALUES (?, ?, ?)`,
            [migrationId, currentBatch, now],
          );
        }
      } catch {
        // Old schema fallback — try description/content/passed columns
        await adapterExecute(db,
          `INSERT INTO "${MIGRATION_TABLE}" (description, content, passed, run_at) VALUES (?, ?, 1, ?)`,
          [migrationId, sqlContent, now],
        );
      }

      await adapterCommit(db);
      result.applied.push(file);
    } catch (err) {
      try {
        await adapterRollback(db);
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
 * Get migration status: which migrations are completed and which are pending.
 *
 * @param adapter - A DatabaseAdapter instance (or omit to use the global adapter).
 * @param options - Optional configuration.
 * @returns Object with `completed` and `pending` arrays of filenames.
 */
export async function status(
  adapter?: DatabaseAdapter,
  options?: { migrationsDir?: string },
): Promise<MigrationStatus> {
  const db = adapter ?? getAdapter();
  const dir = resolve(options?.migrationsDir ?? "migrations");

  const result: MigrationStatus = { completed: [], pending: [] };

  if (!existsSync(dir)) {
    return result;
  }

  // Ensure tracking table exists
  if (!(await adapterTableExists(db, MIGRATION_TABLE))) {
    // No table means nothing has been run — all files are pending
    const files = sortMigrationFiles(
      readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")),
    );
    result.pending = files;
    return result;
  }

  // Collect .sql files (exclude .down.sql)
  const files = sortMigrationFiles(
    readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")),
  );

  // Get all applied migration names from the DB
  const appliedNames = new Set<string>();
  try {
    const rows = await adapterQuery<{ name: string }>(db,
      `SELECT name FROM "${MIGRATION_TABLE}"`,
    );
    for (const row of rows) {
      appliedNames.add(row.name);
    }
  } catch {
    // Old schema with 'description' column
    try {
      const rows = await adapterQuery<{ description: string; passed: number }>(db,
        `SELECT description, passed FROM "${MIGRATION_TABLE}" WHERE passed = 1`,
      );
      for (const row of rows) {
        appliedNames.add(row.description);
      }
    } catch {
      // No valid tracking — treat all as pending
    }
  }

  for (const file of files) {
    const migrationId = file.replace(/\.sql$/, "");
    if (appliedNames.has(migrationId)) {
      result.completed.push(file);
    } else {
      result.pending.push(file);
    }
  }

  return result;
}

/**
 * Create a new empty SQL migration file with a timestamp prefix.
 *
 * Creates BOTH the up migration (.sql) and the down migration (.down.sql).
 *
 * @param description - Human-readable description (used in filename).
 * @param options - Optional configuration.
 * @returns Object with paths to the created up and down files.
 */
export async function createMigration(
  description: string,
  options?: { migrationsDir?: string; kind?: "sql" | "class" },
): Promise<string | { upPath: string; downPath: string }> {
  if (options?.kind === "class") {
    return createClassMigration(description, options);
  }
  const dir = resolve(options?.migrationsDir ?? "migrations");

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Sanitise description for filename
  const safeName = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  // Use YYYYMMDDHHMMSS timestamp prefix
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");

  const upFileName = `${timestamp}_${safeName}.sql`;
  const downFileName = `${timestamp}_${safeName}.down.sql`;
  const upPath = join(dir, upFileName);
  const downPath = join(dir, downFileName);

  const upTemplate = `-- Migration: ${description}\n-- Created: ${now.toISOString()}\n\n`;
  const downTemplate = `-- Rollback: ${description}\n-- Created: ${now.toISOString()}\n\n`;

  writeFileSync(upPath, upTemplate, "utf-8");
  writeFileSync(downPath, downTemplate, "utf-8");

  return { upPath, downPath };
}

/**
 * Create a new TypeScript class-based migration file with a timestamp prefix.
 *
 * @param description - Human-readable description (used in filename and class name).
 * @param options - Optional configuration.
 * @returns Path to the created file.
 */
export async function createClassMigration(
  description: string,
  options?: { migrationsDir?: string },
): Promise<string> {
  const dir = resolve(options?.migrationsDir ?? "migrations");

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const safeName = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  // Derive PascalCase class name
  const className = description
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");

  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");

  const fileName = `${timestamp}_${safeName}.ts`;
  const filePath = join(dir, fileName);

  const content =
    `// Migration: ${description}\n` +
    `// Created: ${now.toISOString()}\n\n` +
    `import type { DatabaseAdapter } from "@tina4/orm";\n\n` +
    `export class ${className} {\n` +
    `  async up(db: DatabaseAdapter): Promise<void> {\n` +
    `    // db.execute("CREATE TABLE ...");\n` +
    `  }\n\n` +
    `  async down(db: DatabaseAdapter): Promise<void> {\n` +
    `    // db.execute("DROP TABLE IF EXISTS ...");\n` +
    `  }\n` +
    `}\n`;

  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/**
 * Object-oriented Migration class — canonical Tina4 Migration API.
 *
 * Provides parity with Python, PHP, and Ruby:
 *   - migrate()           Run all pending migrations
 *   - rollback(steps=1)   Roll back last N batches
 *   - status()            Show completed/pending
 *   - create(description) Scaffold new .sql + .down.sql files
 *   - getApplied()        List applied migrations
 *   - getPending()        List pending migration filenames
 *   - getFiles()          List all migration files on disk
 *
 * @example
 *   const m = new Migration(db, { migrationsDir: "migrations" });
 *   await m.migrate();
 *   await m.rollback(2);
 *   await m.status();
 *   await m.create("add users table");
 */
export class Migration {
  private db?: DatabaseAdapter;
  private dir: string;
  private delimiter: string;

  constructor(db?: DatabaseAdapter, options?: { migrationsDir?: string; delimiter?: string }) {
    this.db = db;
    this.dir = options?.migrationsDir ?? "migrations";
    this.delimiter = options?.delimiter ?? ";";
  }

  /** Run all pending migrations. Returns applied/skipped/failed summary. */
  async migrate(): Promise<MigrationResult> {
    return migrate(this.db, { migrationsDir: this.dir, delimiter: this.delimiter });
  }

  /** Roll back the last N batches. Returns list of rolled-back migration names. */
  async rollback(steps = 1): Promise<string[]> {
    const db = this.db ?? (await import("./database.js")).getAdapter();
    // If tracking table doesn't exist yet there's nothing to roll back
    if (!(await adapterTableExists(db, MIGRATION_TABLE))) return [];
    const rolled: string[] = [];
    for (let i = 0; i < steps; i++) {
      const batch = await rollback(this.dir, this.delimiter);
      if (batch.length === 0) break;
      rolled.push(...batch);
    }
    return rolled;
  }

  /** Get migration status: which are completed and which are pending. */
  async status(): Promise<MigrationStatus> {
    return status(this.db, { migrationsDir: this.dir });
  }

  /**
   * Scaffold a new migration file.
   *
   * kind="sql"   — creates {timestamp}_{description}.sql + .down.sql (default)
   * kind="class" — creates {timestamp}_{description}.ts with a TypeScript class template
   *
   * Returns the path to the created up file (or class file).
   */
  async create(description: string, kind: "sql" | "class" = "sql"): Promise<string | { upPath: string; downPath: string }> {
    if (kind === "class") {
      return createClassMigration(description, { migrationsDir: this.dir });
    }
    return createMigration(description, { migrationsDir: this.dir });
  }

  /** Return list of completed (applied) migration filenames. */
  async getApplied(): Promise<string[]> {
    const s = await this.status();
    return s.completed;
  }

  /** Return list of pending migration filenames. */
  async getPending(): Promise<string[]> {
    const s = await this.status();
    return s.pending;
  }

  /** Return sorted list of all migration files on disk (excludes .down.sql). */
  getFiles(): string[] {
    const dir = resolve(this.dir);
    if (!existsSync(dir)) return [];
    return sortMigrationFiles(
      readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")),
    );
  }
}
