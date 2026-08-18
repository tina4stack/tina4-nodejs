import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Log } from "../../core/src/index.js";
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
 * Check if the adapter is a Firebird adapter.
 *
 * Detection is by the adapter's class name (`constructor.name`) — the engine
 * discriminator used throughout this package (see `engineOf`). A previous
 * duck-type check (`queryAsync` + `translateSql`) was WRONG: every async
 * adapter (Postgres/MySQL/MSSQL) exposes BOTH of those, so the Postgres
 * adapter was mis-identified as Firebird. That routed the migration-tracking
 * CREATE into the Firebird `CREATE GENERATOR` + no-default-id DDL and the
 * record INSERT into the Firebird `GEN_ID()` path — both invalid on Postgres,
 * so `migrate()` died on the FIRST migration with "syntax error" / aborted
 * transaction. Class-name detection fixes the mis-route without altering the
 * runner loop, transaction handling, or raise/return semantics.
 */
/**
 * Unwrap a CachedDatabaseAdapter (what initDatabase() returns) to the concrete
 * underlying adapter. Engine detection keys on constructor.name, which on the
 * wrapper reads "CachedDatabaseAdapter" — so without unwrapping, every real app
 * (all of which go through initDatabase) is mis-detected as SQLite and migrate()
 * emits AUTOINCREMENT on Postgres/MySQL/MSSQL. Drills through any nesting; a raw
 * adapter passes through unchanged.
 */
function unwrapAdapter(db: DatabaseAdapter): DatabaseAdapter {
  let cur: unknown = db;
  while (
    cur &&
    (cur as { constructor?: { name?: string } }).constructor?.name === "CachedDatabaseAdapter" &&
    (cur as { adapter?: unknown }).adapter
  ) {
    cur = (cur as { adapter: unknown }).adapter;
  }
  return cur as DatabaseAdapter;
}

function isFirebirdAdapter(db: DatabaseAdapter): boolean {
  return unwrapAdapter(db).constructor.name === "FirebirdAdapter";
}

/**
 * Check if a column already exists in a Firebird table.
 */
async function firebirdColumnExists(
  db: DatabaseAdapter,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = (await (db as any).queryAsync(
    "SELECT 1 FROM RDB$RELATION_FIELDS WHERE RDB$RELATION_NAME = ? AND TRIM(RDB$FIELD_NAME) = ?",
    [table.toUpperCase(), column.toUpperCase()],
  )) as unknown[];
  return rows.length > 0;
}

/**
 * If stmt is an ALTER TABLE ... ADD on Firebird and the column already exists,
 * returns a skip reason string. Returns null if the statement should execute normally.
 *
 * Exported (like its shouldSkipCreateTable sibling) so it can be driven
 * directly against a REAL Firebird connection in
 * test/migrationContract.test.ts -- no fake adapter needed.
 */
export async function shouldSkipForFirebird(
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
 * Match CREATE TABLE <name> — name may be quoted ("x"), bracketed ([x] MSSQL),
 * or bare. Captures the table name.
 */
const CREATE_TABLE_RE =
  /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|\[([^\]]+)\]|(\w+))/i;

/**
 * Identify the database engine via the adapter's class name.
 * (constructor.name is the engine discriminator used throughout this package.)
 *
 * SQLite is the default for any unrecognized adapter (matches the rest of the
 * package and Python's `db.get_database_type() or "sqlite"`).
 */
function engineOf(
  db: DatabaseAdapter,
): "firebird" | "mssql" | "postgres" | "mysql" | "sqlite" {
  switch (unwrapAdapter(db).constructor.name) {
    case "FirebirdAdapter": return "firebird";
    case "MssqlAdapter": return "mssql";
    case "PostgresAdapter": return "postgres";
    case "MysqlAdapter": return "mysql";
    default: return "sqlite";
  }
}

/**
 * Engine-aware auto-increment integer primary-key column for the
 * `tina4_migration` tracking table.
 *
 * Each engine spells an auto-increment integer PK differently — SQLite uses
 * AUTOINCREMENT, PostgreSQL SERIAL, MySQL AUTO_INCREMENT, MSSQL IDENTITY(1,1).
 * Emitting raw `AUTOINCREMENT` on any non-SQLite engine fails with
 * "syntax error at or near AUTOINCREMENT" — which is exactly why `migrate()`
 * was unusable on PostgreSQL/MySQL/MSSQL. Mirrors the engine-aware id DDL in
 * the adapters' createTableAsync and Python's `_create_v3_table`. (Firebird is
 * handled by its own generator branch and never reaches here.)
 */
function migrationIdColumn(db: DatabaseAdapter): string {
  switch (engineOf(db)) {
    case "postgres": return "id SERIAL PRIMARY KEY";
    case "mysql": return "id INTEGER PRIMARY KEY AUTO_INCREMENT";
    case "mssql": return "id INTEGER IDENTITY(1,1) PRIMARY KEY";
    default: return "id INTEGER PRIMARY KEY AUTOINCREMENT";
  }
}

/**
 * Make CREATE TABLE idempotent on engines lacking IF NOT EXISTS.
 *
 * Firebird and MSSQL do not support `CREATE TABLE IF NOT EXISTS`, so a raw
 * CREATE in a re-run migration raises "object already exists". When the target
 * table already exists on those engines, return a skip reason so the statement
 * is skipped (mirrors the Firebird ALTER-TABLE-ADD idempotency guard).
 * SQLite/MySQL/PostgreSQL support IF NOT EXISTS and are left to the engine.
 * Only a genuine already-exists is skipped — every other error still raises.
 */
export async function shouldSkipCreateTable(
  db: DatabaseAdapter,
  stmt: string,
): Promise<string | null> {
  const engine = engineOf(db);
  if (engine !== "firebird" && engine !== "mssql") return null;

  const m = stmt.match(CREATE_TABLE_RE);
  if (!m) return null;

  const table = m[1] ?? m[2] ?? m[3];
  try {
    if (await adapterTableExists(db, table)) {
      return `Table ${table} already exists, skipping CREATE TABLE`;
    }
  } catch {
    return null;
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
      // addColumn helpers; other engines use getColumns()/ALTER TABLE.
      //
      // Collapsing this into getColumns() looks obviously right and is NOT:
      // it broke the legacy NOT NULL migration_id path, which is the bug that
      // wedged every migration for ~20 releases (python#93). getTableColumns
      // reads PRAGMA directly; getColumns goes through schema splitting and
      // does not return the same thing here. Removing it needs its own change
      // with that path tested, not a drive-by in an interface tidy-up.
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
  const engine = unwrapAdapter(adapter).constructor.name;
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
 * The tracking-table identifier, quoted for the CALLING adapter's engine.
 *
 * SQLite, PostgreSQL, MSSQL and Firebird all accept ANSI double-quoted
 * identifiers, but MySQL's default sql_mode (no ANSI_QUOTES — the stock
 * `mysql:8` image never sets it) parses `"..."` as a STRING LITERAL, not an
 * identifier. `CREATE TABLE "tina4_migration" (...)` on a database where the
 * table does not already exist fails: "You have an error in your SQL syntax
 * ... near '"tina4_migration" ('" — MEASURED against a real fresh MySQL 8
 * container (a long-lived dev database that already has the table masks this
 * completely, which is exactly why it only ever surfaced on CI's ephemeral
 * one). Backticks are MySQL's identifier quote and are accepted in every
 * sql_mode, so they are always correct there.
 */
function mt(db: DatabaseAdapter): string {
  const engine = engineOf(db);

  // Firebird: leave it UNQUOTED so it folds to the upper-case TINA4_MIGRATION
  // that the PHP and Python masters create. A quoted lower-case identifier is a
  // DIFFERENT, case-sensitive table there, so a quoted spelling cannot see a
  // ledger written by another Tina4 language — while tableExists() matches
  // case-insensitively and reports it present, so the INSERT fails alone.
  if (engine === "firebird") return MIGRATION_TABLE;

  return engine === "mysql" ? `\`${MIGRATION_TABLE}\`` : `"${MIGRATION_TABLE}"`;
}

/**
 * Derive a human-readable description from a migration name, matching the
 * Python master: strip a leading numeric/timestamp prefix and turn `_` into
 * spaces. `20250101120000_create_users` -> `create users`.
 */
function deriveDescription(name: string): string {
  return name.replace(/^\d+_/, "").replace(/_/g, " ");
}

/**
 * Build an `ALTER TABLE ... ADD` statement for the tracking table. Firebird
 * uses `ADD <col>` (no COLUMN keyword); every other engine uses `ADD COLUMN`.
 */
function migrationAddColumnSql(db: DatabaseAdapter, col: string, type: string, extra = ""): string {
  return `ALTER TABLE ${mt(db)} ADD ${isFirebirdAdapter(db) ? "" : "COLUMN "}${col} ${type}${extra}`;
}

/**
 * The canonical `tina4_migration` bookkeeping shape, shared across all four
 * Tina4 frameworks (3.13.55 parity):
 *
 *   id             <engine auto-increment PK — migrationIdColumn() / Firebird generator>
 *   migration_name VARCHAR(500) NOT NULL UNIQUE
 *   description    VARCHAR(500)
 *   batch          INTEGER NOT NULL DEFAULT 1
 *   executed_at    VARCHAR(50)   -- a written ISO-8601 string, NOT a CURRENT_TIMESTAMP default
 *   passed         INTEGER NOT NULL DEFAULT 1
 *
 * A migration is "applied" iff a row exists with passed = 1. Operates on the
 * passed adapter so both ensureMigrationTable() (global adapter) and migrate()
 * (its own adapter) share ONE implementation — mirrors Python's single
 * `_ensure_tracking_table`.
 */
async function ensureMigrationTableOn(db: DatabaseAdapter): Promise<void> {
  if (!(await adapterTableExists(db, MIGRATION_TABLE))) {
    if (isFirebirdAdapter(db)) {
      // Firebird: no AUTOINCREMENT, no TEXT type, use a generator for IDs.
      try {
        await adapterExecute(db, "CREATE GENERATOR GEN_TINA4_MIGRATION_ID");
        try { await adapterExecute(db, "COMMIT"); } catch { /* ignore */ }
      } catch {
        // Generator may already exist
      }
      await adapterExecute(db, `CREATE TABLE ${mt(db)} (
        id INTEGER NOT NULL PRIMARY KEY,
        migration_name VARCHAR(500) NOT NULL UNIQUE,
        description VARCHAR(500),
        batch INTEGER DEFAULT 1 NOT NULL,
        executed_at VARCHAR(50) NOT NULL,
        passed INTEGER DEFAULT 1 NOT NULL
      )`);
    } else {
      // Engine-aware bookkeeping DDL (non-Firebird). Each engine spells an
      // auto-increment integer PK differently — SQLite AUTOINCREMENT, Postgres
      // SERIAL, MySQL AUTO_INCREMENT, MSSQL IDENTITY(1,1) — via
      // migrationIdColumn(). migration_name is VARCHAR (a TEXT column cannot
      // carry UNIQUE on MySQL); SQLite gives VARCHAR TEXT affinity so it stays
      // behaviour-identical there. executed_at is a plain VARCHAR(50) written
      // explicitly (new Date().toISOString()) — NOT a CURRENT_TIMESTAMP default.
      const idCol = migrationIdColumn(db);
      const engine = engineOf(db);
      const ifNotExists = engine === "mssql" ? "" : "IF NOT EXISTS ";
      await adapterExecute(db, `CREATE TABLE ${ifNotExists}${mt(db)} (
        ${idCol},
        migration_name VARCHAR(500) NOT NULL UNIQUE,
        description VARCHAR(500),
        batch INTEGER NOT NULL DEFAULT 1,
        executed_at VARCHAR(50) NOT NULL,
        passed INTEGER NOT NULL DEFAULT 1
      )`);
    }
    return;
  }
  await upgradeMigrationTable(db);
}

/**
 * Non-destructive in-place upgrade of an existing tracking table.
 *
 * A table created by an OLDER v3 (<= 3.13.54) has `name` + `applied_at` and no
 * `migration_name`/`description`/`passed`. Detect that shape, ADD the canonical
 * columns, and copy the values across (`migration_name = name`, `passed = 1`,
 * `executed_at = applied_at`) so already-applied migrations are still seen as
 * applied and are NOT re-run. The old `name`/`applied_at` columns are left in
 * place (harmless, ignored from now on). Any other legacy shape only has its
 * missing `batch` column ensured (preserves the prior behaviour).
 */
async function upgradeMigrationTable(db: DatabaseAdapter): Promise<void> {
  let cols: Set<string>;
  try {
    const columns = (db as any).getTableColumns
      ? (db as SQLiteAdapter).getTableColumns(MIGRATION_TABLE)
      : await adapterColumns(db, MIGRATION_TABLE);
    cols = new Set(columns.map((c) => c.name.toLowerCase()));
  } catch {
    return; // cannot introspect — leave the table untouched
  }

  const fb = isFirebirdAdapter(db);

  if (cols.has("name") && !cols.has("migration_name")) {
    // Old-v3 -> canonical. Firebird has no TEXT type, so VARCHAR there.
    const nameType = fb ? "VARCHAR(500)" : "TEXT";
    const tsType = fb ? "VARCHAR(50)" : "TEXT";

    const tryExec = async (sql: string): Promise<void> => {
      try { await adapterExecute(db, sql); } catch { /* column may already exist */ }
    };

    await tryExec(migrationAddColumnSql(db, "migration_name", nameType));
    if (!cols.has("description")) await tryExec(migrationAddColumnSql(db, "description", nameType));
    if (!cols.has("passed")) await tryExec(migrationAddColumnSql(db, "passed", "INTEGER", " DEFAULT 1"));
    if (!cols.has("executed_at")) await tryExec(migrationAddColumnSql(db, "executed_at", tsType));
    if (!cols.has("batch")) await tryExec(migrationAddColumnSql(db, "batch", "INTEGER", " DEFAULT 1"));

    // Copy legacy values across so applied migrations remain applied.
    await tryExec(`UPDATE ${mt(db)} SET migration_name = name WHERE migration_name IS NULL`);
    await tryExec(`UPDATE ${mt(db)} SET passed = 1 WHERE passed IS NULL`);
    if (cols.has("applied_at")) {
      await tryExec(`UPDATE ${mt(db)} SET executed_at = applied_at WHERE executed_at IS NULL`);
    }
    return;
  }

  // Any other legacy shape: just ensure the batch column exists (prior behaviour).
  if (!cols.has("batch")) {
    try {
      await adapterExecute(db, migrationAddColumnSql(db, "batch", "INTEGER", " NOT NULL DEFAULT 1"));
    } catch {
      // ignore — column may already exist
    }
  }
}

/**
 * Ensure the migration tracking table exists in the canonical shape (creating
 * it or upgrading an older one in place) on the global adapter.
 */
export async function ensureMigrationTable(): Promise<void> {
  await ensureMigrationTableOn(getAdapter());
}

/**
 * Get the current batch number (max batch + 1).
 */
export async function getNextBatch(): Promise<number> {
  const adapter = getAdapter();
  const rows = await adapterQuery<{ max_batch: number | null }>(adapter,
    `SELECT MAX(batch) as max_batch FROM ${mt(adapter)} WHERE passed = 1`,
  );
  return (rows[0]?.max_batch ?? 0) + 1;
}

/**
 * Check if a migration has already been applied (a row with passed = 1).
 */
export async function isMigrationApplied(name: string): Promise<boolean> {
  const adapter = getAdapter();
  const rows = await adapterQuery(adapter,
    `SELECT id FROM ${mt(adapter)} WHERE migration_name = ? AND passed = 1`,
    [name],
  );
  return rows.length > 0;
}

/**
 * Write the canonical "applied" bookkeeping row for a migration.
 *
 * DELETEs any existing row for this migration_name FIRST, then INSERTs the
 * fresh row. A leftover passed=0 row (a prior failure recorded via the public
 * recordMigration() API, or one carried over from a <= 3.13.54 upgrade) is
 * therefore superseded, so the migration re-applies cleanly instead of colliding
 * on the UNIQUE migration_name constraint when the fresh passed=1 row is
 * INSERTed (that collision used to wedge a previously-failed migration).
 * DELETE+INSERT is portable across every engine (no UPSERT dialect variance) and
 * holds the invariant that the table carries AT MOST ONE row per migration_name -
 * latest state wins.
 *
 * Operates on the passed adapter so both migrate() (its own adapter) and
 * recordMigration() (the global adapter) share ONE implementation - mirrors the
 * Python master's single _record_applied(). Preserves the Firebird generator-id
 * branch (no AUTOINCREMENT on Firebird). Writes the canonical columns:
 * migration_name, a derived description, batch, an explicit ISO-8601 executed_at
 * timestamp, and passed (default 1).
 */
async function recordApplied(
  db: DatabaseAdapter,
  name: string,
  batch: number,
  passed: number = 1,
): Promise<void> {
  const now = new Date().toISOString();
  const description = deriveDescription(name);
  // Delete-before-insert: supersede any leftover row for this migration_name so
  // the INSERT below never collides on the UNIQUE migration_name.
  await adapterExecute(db,
    `DELETE FROM ${mt(db)} WHERE migration_name = ?`,
    [name],
  );
  // Build the column list from the columns that ACTUALLY exist on the table, so
  // a legacy column left behind by an in-place upgrade is populated rather than
  // defaulted to NULL. Node never created a `migration_id` column, but a Node app
  // can be pointed at a database whose tina4_migration table was created by
  // tina4-python v3 <= 3.13.54 - there `migration_id` is NOT NULL, and an insert
  // that omits it fails, wedging every migration on that database
  // (tina4-python#93). Mirrors the PHP + Python masters.
  const cols = await trackingColumns(db);
  const insertCols = ["migration_name", "description", "batch", "executed_at", "passed"];
  const values: unknown[] = [name, description, batch, now, passed];

  if (cols.has("migration_id")) {
    insertCols.push("migration_id");
    values.push(name);
  }

  if (isFirebirdAdapter(db)) {
    // Firebird: generate the id from the sequence.
    const rows = await adapterQuery<{ next_id: number }>(db,
      "SELECT GEN_ID(GEN_TINA4_MIGRATION_ID, 1) AS NEXT_ID FROM RDB$DATABASE",
    );
    insertCols.unshift("id");
    values.unshift(rows[0]?.next_id ?? 1);
  }

  const placeholders = insertCols.map(() => "?").join(", ");
  await adapterExecute(db,
    `INSERT INTO ${mt(db)} (${insertCols.join(", ")}) VALUES (${placeholders})`,
    values,
  );
}

/**
 * Lowercased column names on the tracking table. Returns an empty set on any
 * failure so a missing/unreadable table falls back to the canonical columns.
 */
async function trackingColumns(db: DatabaseAdapter): Promise<Set<string>> {
  try {
    // The DatabaseAdapter contract exposes getColumns() (feature 3: renamed from
    // columns() to match the other three frameworks and the get- prefix used
    // everywhere else).
    //
    // This reads through `as any`, so the compiler could not catch the rename
    // here - it went silently to undefined, `cols` came back empty, migration_id
    // was left out of the insert and every migration failed on the legacy
    // NOT NULL column. Exactly the failure python#93 caused, from the opposite
    // direction. Kept optional-chained for adapters that predate the contract.
    const cols = await (db as any).getColumns?.(MIGRATION_TABLE);
    if (!Array.isArray(cols)) return new Set();
    return new Set(
      cols.map((c: any) => String(c?.name ?? c ?? "").toLowerCase()).filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/**
 * Record a migration as applied (public API). Routes through recordApplied() so
 * a leftover passed=0 row for the same migration_name is deleted before the
 * fresh row is written (at most one row per migration_name).
 */
export async function recordMigration(name: string, batch: number, passed: number = 1): Promise<void> {
  await recordApplied(getAdapter(), name, batch, passed);
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
export async function getLastBatchMigrations(): Promise<Array<{ id: number; migration_name: string; batch: number }>> {
  const adapter = getAdapter();
  const rows = await adapterQuery<{ max_batch: number | null }>(adapter,
    `SELECT MAX(batch) as max_batch FROM ${mt(adapter)} WHERE passed = 1`,
  );
  const lastBatch = rows[0]?.max_batch;
  if (lastBatch === null || lastBatch === undefined) return [];

  return adapterQuery<{ id: number; migration_name: string; batch: number }>(adapter,
    `SELECT id, migration_name, batch FROM ${mt(adapter)} WHERE batch = ? AND passed = 1 ORDER BY id DESC`,
    [lastBatch],
  );
}

/**
 * Remove a migration record (used during rollback).
 */
export async function removeMigrationRecord(name: string): Promise<void> {
  const adapter = getAdapter();
  await adapterExecute(adapter,
    `DELETE FROM ${mt(adapter)} WHERE migration_name = ?`,
    [name],
  );
}

/**
 * Rollback the last batch of migrations using .down.sql files.
 *
 * FAIL-SAFE (MIG-DEC-02, reuses the Python reference model): for each
 * migration in the last batch (in reverse order), the down artifact must
 * actually run before the tracking record is removed. A MISSING .down.sql
 * (or, on the legacy Map API, no registered down function) or a FAILING down
 * statement now THROWS instead of logging a warning/error and still deleting
 * the record — the old behaviour was the exact MIG-ROLLBACK-DROPS-LEDGER bug:
 * the schema stayed applied but the ledger row vanished, silently untracked.
 * The DELETE runs inside the SAME transaction as the down statements, so a
 * partially-executed down (some statements ran, a later one failed) rolls
 * back too — no half-reversed schema left behind either.
 *
 * @param migrationsDir - Directory containing migration files (default: "migrations")
 * @param delimiter - SQL statement delimiter (default: ";")
 * @returns Array of the down-migration files that were run, e.g.
 *   "000001_create_users.down.sql". (The legacy down-FUNCTION Map API returns the
 *   bare migration name instead, since no .down.sql file is involved there.)
 * @throws When a migration in the batch has no down artifact, or its down
 *   statement(s) fail — the batch stops at that migration; earlier
 *   migrations in the SAME call that already rolled back stay rolled back
 *   (each is its own transaction).
 *
 * NOTE on return form (intentional, cross-framework): migration return values reflect
 * WHAT each method acted on, so the forms differ by method and that is by design (not
 * unified). migrate()/getApplied()/getPending() return the up-migration filename
 * ("name.sql"); rollback() returns the DOWN-migration filename it executed
 * ("name.down.sql") — matching the Python master. So a caller diffing rollback()
 * against getApplied() compares ".down.sql" vs ".sql": strip the suffixes (or compare
 * the bare "name" stem) to relate them.
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
      const down = downFunctions.get(migration.migration_name);
      if (!down) {
        throw new Error(
          `Cannot rollback ${migration.migration_name}: no down function registered`,
        );
      }
      await down();
      await removeMigrationRecord(migration.migration_name);
      // Legacy down-FUNCTION API: no .down.sql file is involved here, so return the
      // bare migration name (the file-based path below returns "name.down.sql").
      rolledBack.push(migration.migration_name);
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
    const downFile = `${migration.migration_name}.down.sql`;
    const downPath = join(dir, downFile);

    if (!existsSync(downPath)) {
      throw new Error(
        `Cannot rollback ${migration.migration_name}: no .down.sql file found`,
      );
    }

    const sqlContent = readFileSync(downPath, "utf-8").trim();
    if (sqlContent) {
      const statements = splitStatements(sqlContent, delim);
      try {
        await adapterStartTransaction(db);
        for (const stmt of statements) {
          await adapterExecute(db, stmt);
        }
        // Remove the tracking record INSIDE the same transaction as the down
        // statements, so a failure below rolls back the DDL too, not just the
        // record removal.
        await removeMigrationRecord(migration.migration_name);
        await adapterCommit(db);
      } catch (err) {
        try {
          await adapterRollback(db);
        } catch {
          // rollback may fail if auto-rolled-back
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Rollback failed: ${migration.migration_name} — ${msg}`);
      }
    } else {
      // An EXISTING but empty/comment-only .down.sql (0 statements) is a
      // deliberate no-op success — matches the Python reference
      // (createMigration scaffolds an empty .down.sql by default).
      await removeMigrationRecord(migration.migration_name);
    }

    // Return the down-migration file that was run (e.g. "name.down.sql"), matching
    // the Python master's rollback return form.
    rolledBack.push(`${migration.migration_name}.down.sql`);
  }

  return rolledBack;
}

/**
 * Get all applied migrations.
 */
export async function getAppliedMigrations(): Promise<Array<{ id: number; migration_name: string; description: string; batch: number; executed_at: string; passed: number }>> {
  const adapter = getAdapter();
  return adapterQuery<{ id: number; migration_name: string; description: string; batch: number; executed_at: string; passed: number }>(adapter,
    `SELECT * FROM ${mt(adapter)} WHERE passed = 1 ORDER BY id ASC`,
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
 * Smart/curly quotes — editors, word processors, docs and chat apps silently
 * convert a straight " to “ ” and a straight ' to ‘ ’ (plus primes ′ ″). Those
 * characters are NOT valid SQL string/identifier delimiters, so a pasted-in
 * migration fails to run ("syntax error near …"). Map them back to straight
 * ASCII quotes. (Real string CONTENTS are unaffected by intent — we only swap
 * the lookalike code points for their ASCII equivalents.)
 */
const SMART_QUOTES: Record<string, string> = {
  // Double-quote lookalikes → straight " (U+0022)
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
  // Single-quote / apostrophe lookalikes → straight ' (U+0027)
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
};
const SMART_QUOTE_RE = new RegExp(`[${Object.keys(SMART_QUOTES).join("")}]`, "g");

/**
 * Replace smart/curly quotes with straight ASCII quotes so migration SQL
 * authored or pasted from an editor/doc actually runs (those code points are
 * not valid SQL delimiters). Already-straight quotes and ordinary string
 * content are returned byte-for-byte unchanged.
 */
export function normalizeQuotes(sql: string): string {
  return sql.replace(SMART_QUOTE_RE, (ch) => SMART_QUOTES[ch]);
}

const SET_TERM_RE = /^SET\s+TERM\s+(\S+)$/i;

/**
 * Return the new terminator from a `SET TERM <new> <current>` directive.
 *
 * `SET TERM` is a script-level directive (recognised by isql and other
 * InterBase/Firebird tooling, not run by the engine) that changes the
 * terminator separating statements. Recognising it lets a statement whose own
 * body contains the default `;` terminator — a trigger, stored procedure or
 * `EXECUTE BLOCK` — be kept intact rather than split on those inner `;`. The
 * terminator may be more than one character (e.g. `!!`).
 *
 * @param statement A single, already-trimmed statement.
 * @returns The new terminator, or `null` when `statement` is not a `SET TERM`
 *          directive.
 */
export function parseSetTerm(statement: string): string | null {
  const m = statement.trim().match(SET_TERM_RE);
  return m ? m[1] : null;
}

/**
 * Split SQL text into individual statements with a single-pass, quote- and
 * comment-aware scanner. The split decision is made character by character so
 * the delimiter only ever fires in real statement position.
 *
 * This is the fix for issue #54: the old implementation split on `delimiter`
 * BEFORE stripping `-- …` line comments, so a `;` inside a line comment
 * fragmented one statement into several broken pieces. A scanner that knows
 * where it is (code / comment / string) cannot make that mistake.
 *
 * Handled, in priority order, only when NOT already inside a stored-proc block:
 * - `$$ … $$` and `// … //` stored-proc blocks are kept intact (inner `;` never
 *   splits). A `//` preceded by `:` is a URL scheme (`https://…`), not a delimiter.
 * - `/* … *​/` block comments are stripped.
 * - `-- …` line comments are stripped to end of line (the newline is kept).
 * - `'…'` single-quoted strings and `"…"` double-quoted identifiers are copied
 *   verbatim, honouring the SQL doubled-quote escape (`''` / `""`); a `;`, `--`
 *   or `/*` inside a literal is data, not a delimiter or comment.
 * - A `SET TERM <new> <current>` directive switches the active terminator and is
 *   consumed (never emitted), so a statement whose own body contains the default
 *   terminator — a Firebird trigger, stored procedure or `EXECUTE BLOCK` —
 *   survives as one. Multi-character terminators (e.g. `!!`) are supported.
 * Mirrors the tina4-python `_split_statements` / tina4-php / tina4-ruby scanner (parity).
 */
export function splitStatements(sql: string, delimiter = ";"): string[] {
  // Normalize smart/curly quotes to straight ASCII first, so SQL pasted from
  // an editor/doc (which converts " → “ ” and ' → ‘ ’) actually runs.
  sql = normalizeQuotes(sql);

  const statements: string[] = [];
  let current = "";
  const n = sql.length;
  // Active statement terminator. Starts as the delimiter argument; a SET TERM
  // directive can switch it mid-script (dlen recomputed) so a statement whose
  // own body contains the default terminator stays intact.
  let dlen = delimiter.length;
  let i = 0;
  let inDollarBlock = false;
  let inSlashBlock = false;

  while (i < n) {
    const ch = sql[i];

    // $$ … $$ stored-proc block (toggle).
    if (!inSlashBlock && ch === "$" && i + 1 < n && sql[i + 1] === "$") {
      current += "$$";
      i += 2;
      inDollarBlock = !inDollarBlock;
      continue;
    }

    // // … // stored-proc block (toggle) — but NOT a `://` URL scheme.
    if (
      !inDollarBlock && ch === "/" && i + 1 < n && sql[i + 1] === "/" &&
      !(i > 0 && sql[i - 1] === ":")
    ) {
      current += "//";
      i += 2;
      inSlashBlock = !inSlashBlock;
      continue;
    }

    // Inside a stored-proc block: consume verbatim (inner ; never splits).
    if (inDollarBlock || inSlashBlock) {
      current += ch;
      i += 1;
      continue;
    }

    // Block comment /* … */ — stripped.
    if (ch === "/" && i + 1 < n && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end !== -1 ? end + 2 : n;
      continue;
    }

    // Line comment -- … — stripped to end of line; the newline is left for the
    // next iteration so line structure (and NEXT-line boundaries) survive.
    if (ch === "-" && i + 1 < n && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      i = end !== -1 ? end : n;
      continue;
    }

    // Single-quoted string literal — '' escapes a quote. Copied verbatim.
    if (ch === "'") {
      current += "'";
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && i + 1 < n && sql[i + 1] === "'") {
          current += "''";
          i += 2;
        } else if (sql[i] === "'") {
          current += "'";
          i += 1;
          break;
        } else {
          current += sql[i];
          i += 1;
        }
      }
      continue;
    }

    // Double-quoted identifier — "" escapes a quote. Same verbatim handling.
    if (ch === '"') {
      current += '"';
      i += 1;
      while (i < n) {
        if (sql[i] === '"' && i + 1 < n && sql[i + 1] === '"') {
          current += '""';
          i += 2;
        } else if (sql[i] === '"') {
          current += '"';
          i += 1;
          break;
        } else {
          current += sql[i];
          i += 1;
        }
      }
      continue;
    }

    // Statement delimiter — only reached outside blocks/comments/strings. A
    // SET TERM directive switches the active terminator and is consumed (never
    // emitted); any other completed statement is collected.
    if (dlen > 0 && sql.startsWith(delimiter, i)) {
      i += dlen;
      const stmt = current.trim();
      current = "";
      if (stmt) {
        const newTerm = parseSetTerm(stmt);
        if (newTerm !== null) {
          delimiter = newTerm;
          dlen = delimiter.length;
        } else {
          statements.push(stmt);
        }
      }
      continue;
    }

    current += ch;
    i += 1;
  }

  // Trailing statement (may not end with a delimiter). A trailing SET TERM
  // directive is a no-op — consume it, don't emit it.
  const stmt = current.trim();
  if (stmt && parseSetTerm(stmt) === null) statements.push(stmt);
  return statements;
}

/**
 * Sort migration filenames supporting both naming patterns:
 * - Sequential: 000001_name.sql, 000002_name.sql
 * - Timestamp: 20240315120000_name.sql (YYYYMMDDHHMMSS)
 *
 * Numeric-aware: a file with a leading numeric/timestamp prefix sorts first by
 * that number (so `9_*` applies before `10_*` — a plain lexical sort misorders
 * unpadded prefixes because "10" < "9"). Files with NO numeric prefix sort
 * AFTER the numbered ones, then lexically. Mirrors Python's `_migration_sort_key`.
 */
export function sortMigrationFiles(files: string[]): string[] {
  // Returns a tuple-like key: [group, numeric, name].
  // group 0 = has numeric prefix (sorts first); group 1 = no prefix (sorts after).
  const key = (name: string): [number, bigint, string] => {
    const m = name.match(/^(\d+)/);
    return m ? [0, BigInt(m[1]), name] : [1, 0n, name];
  };
  return [...files].sort((a, b) => {
    const [ag, an, anm] = key(a);
    const [bg, bn, bnm] = key(b);
    if (ag !== bg) return ag - bg;
    if (an < bn) return -1;
    if (an > bn) return 1;
    return anm.localeCompare(bnm);
  });
}

/**
 * Warn (once) about migration filenames without a recognized NNNNNN_/timestamp
 * prefix — their ordering relative to numbered migrations is undefined, a silent
 * out-of-order-apply footgun. Mirrors Python's runner.
 */
function warnUnprefixedMigrations(files: string[]): void {
  const unprefixed = files.filter((f) => !/^\d+[_-]/.test(f));
  if (unprefixed.length > 0) {
    Log.warning(
      "Migration file(s) without a numeric/timestamp prefix may apply out of order: " +
        unprefixed.join(", "),
    );
  }
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

  // Ensure the canonical tracking table exists (creates it, or upgrades an
  // older <= 3.13.54 `name`/`applied_at` table in place). Shared with
  // ensureMigrationTable() so both paths produce the identical schema.
  await ensureMigrationTableOn(db);

  // Collect .sql files (exclude .down.sql), numeric-aware sorted (9_ before 10_).
  const files = sortMigrationFiles(
    readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")),
  );

  if (files.length === 0) return result;

  // Warn about files without a recognized numeric/timestamp prefix — their
  // ordering relative to numbered migrations is undefined.
  warnUnprefixedMigrations(files);

  // Determine the batch number for this run
  let currentBatch = 1;
  try {
    const batchRows = await adapterQuery<{ max_batch: number | null }>(db,
      `SELECT MAX(batch) as max_batch FROM ${mt(db)} WHERE passed = 1`,
    );
    currentBatch = (batchRows[0]?.max_batch ?? 0) + 1;
  } catch {
    // Table may have old schema without batch column
    currentBatch = 1;
  }

  for (const file of files) {
    const migrationId = file.replace(/\.sql$/, "");

    // Applied iff a row exists with passed = 1. ensureMigrationTableOn() above
    // guarantees the canonical migration_name column (fresh or upgraded).
    let alreadyApplied = false;
    try {
      const existing = await adapterQuery<{ id: number }>(db,
        `SELECT id FROM ${mt(db)} WHERE migration_name = ? AND passed = 1`,
        [migrationId],
      );
      alreadyApplied = existing.length > 0;
    } catch {
      alreadyApplied = false;
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
        // Idempotency on engines lacking IF NOT EXISTS: Firebird ALTER-TABLE-ADD,
        // and CREATE TABLE on Firebird/MSSQL. Pre-check the catalogue so a genuine
        // already-exists is skipped instead of raising — every other error still
        // raises (rolls the file back).
        const skipReason =
          (await shouldSkipForFirebird(db, stmt)) ?? (await shouldSkipCreateTable(db, stmt));
        if (skipReason) {
          console.log(`  Migration ${file}: ${skipReason}`);
          continue;
        }
        await adapterExecute(db, stmt);
      }

      // Record as applied (passed = 1) via recordApplied(), which DELETEs any
      // leftover row for this migration_name before the fresh INSERT - so a
      // previously-failed migration (a leftover passed=0 row) re-applies
      // cleanly instead of colliding on the UNIQUE migration_name. Both the
      // DELETE and INSERT run inside this file's open transaction.
      await recordApplied(db, migrationId, currentBatch);

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
      // STOP at the first failure (parity with Python/PHP/Ruby). The file rolled
      // back; later migrations must NOT be applied on top of a missing earlier
      // one (a missing column / table would cascade silent corruption). Already-
      // applied files stay applied — fix the bad file and re-run.
      Log.error(`Migration stopped at first failure: ${file} — ${msg}`);
      break;
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

  // The table exists — upgrade an older <= 3.13.54 shape in place so the
  // canonical migration_name column is readable below (never creates a table
  // here; the tableExists check above already returned for the absent case).
  await ensureMigrationTableOn(db);

  // Collect .sql files (exclude .down.sql)
  const files = sortMigrationFiles(
    readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")),
  );

  // Get all applied migration names (passed = 1) from the DB.
  const appliedNames = new Set<string>();
  try {
    const rows = await adapterQuery<{ migration_name: string }>(db,
      `SELECT migration_name FROM ${mt(db)} WHERE passed = 1`,
    );
    for (const row of rows) {
      if (row.migration_name) appliedNames.add(row.migration_name);
    }
  } catch (err) {
    // The tracking table exists (checked above) but reading applied-state
    // failed — do NOT silently report every migration as pending. That
    // masked a real bug: passing the Database WRAPPER (no .query) instead of a
    // raw adapter made adapterQuery throw here, so status() reported all-pending
    // and the MCP migration_run re-applied everything each call. Log loud so a
    // wrong-arg / bad adapter can never again hide as "nothing applied yet".
    // (Python master #57 "don't swallow" lesson.) Applied-state stays empty for
    // this call, but the cause is now visible instead of masked.
    Log.error(`Migration status: could not read applied migrations from "${MIGRATION_TABLE}" — ${(err as Error).message}`);
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
  options?: { migrationsDir?: string; kind?: "sql" | "code" | "class" },
): Promise<string | { upPath: string; downPath: string }> {
  // MEASURED 2026-08-06: the accepted kind differed in every framework -
  // python "python", php "php", ruby "ruby" OR "python", node "class" - and
  // NONE validated it, so create_migration(..., kind="python") produced a code
  // migration in Python and Ruby and a SILENT .sql file in PHP and Node.
  // "code" is now the canonical spelling in all four; each keeps its own
  // language name as a legacy alias; anything else raises.
  const kind = (options?.kind ?? "sql").trim().toLowerCase();
  if (!["sql", "code", "class"].includes(kind)) {
    throw new Error(
      `Unknown migration kind "${kind}". Use "sql" (default) or "code" ` +
        `(alias: "class"). An unrecognised kind used to produce a .sql file ` +
        `silently, which is why this now throws.`,
    );
  }

  if (kind === "code" || kind === "class") {
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
    `import type { DatabaseAdapter } from "tina4-nodejs/orm";\n\n` +
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
   * kind="code"  — creates {timestamp}_{description}.ts with a TypeScript class
   *                 template. "class" is accepted as a legacy alias.
   *
   * Returns the path to the created up file (or class file).
   */
  async create(
    description: string,
    kind: "sql" | "code" | "class" = "sql",
  ): Promise<string | { upPath: string; downPath: string }> {
    // Route through createMigration so the validation lives in ONE place - a
    // second copy of the accepted set is a second place for it to drift.
    return createMigration(description, { migrationsDir: this.dir, kind });
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
