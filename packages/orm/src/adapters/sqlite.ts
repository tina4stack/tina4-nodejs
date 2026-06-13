import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DatabaseAdapter, DatabaseResult, ColumnInfo, FieldDefinition } from "../types.js";
import { SQLTranslator } from "../sqlTranslation.js";

/** A safe-to-interpolate SQL identifier (no quoting/escaping needed). */
function isIdentifier(str: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(str);
}

/**
 * Resolve a SQLite path argument against the project root (cwd).
 *
 * Matches the tina4-python + tina4-php convention:
 *   ":memory:"         → passthrough
 *   "data/app.db"      → {cwd}/data/app.db  (auto-mkdir under cwd)
 *   "/abs/app.db"      → /abs/app.db        (NO auto-mkdir; user's responsibility)
 *   "C:/Users/app.db"  → C:/Users/app.db    (NO auto-mkdir)
 *
 * Never mkdir a directory that isn't a descendant of cwd — that was the
 * root cause of the `EROFS: read-only file system, mkdir '/data'` crash
 * reported on macOS.
 */
function resolveSqlitePath(dbPath: string): string {
  if (dbPath === ":memory:") return dbPath;

  let path = dbPath;
  if (!isAbsolute(path)) {
    path = join(process.cwd(), path);
    // Auto-mkdir is safe here — we know the parent is under cwd
    mkdirSync(dirname(path), { recursive: true });
  } else {
    // Absolute path. Only auto-mkdir if it's a descendant of cwd.
    const cwd = resolve(process.cwd());
    const abs = resolve(path);
    if (abs.startsWith(cwd + "/") || abs === cwd) {
      mkdirSync(dirname(abs), { recursive: true });
    }
    // Otherwise, trust the user — don't touch the filesystem.
  }
  return path;
}

export class SQLiteAdapter implements DatabaseAdapter {
  private db: DatabaseSync;
  private _lastInsertId: number | bigint | null = null;

  constructor(dbPath: string) {
    const resolved = resolveSqlitePath(dbPath);
    this.db = new DatabaseSync(resolved);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  execute(sql: string, params?: unknown[]): unknown {
    const stmt = this.db.prepare(sql);
    const result = params ? stmt.run(...params) : stmt.run();
    if (result && typeof result === "object" && "lastInsertRowid" in result) {
      this._lastInsertId = result.lastInsertRowid as number | bigint;
    }
    return result;
  }

  executeMany(sql: string, paramsList: unknown[][]): { totalAffected: number; lastInsertId?: number | bigint } {
    const stmt = this.db.prepare(sql);
    let totalAffected = 0;
    let lastId: number | bigint | undefined;

    this.db.exec("BEGIN TRANSACTION");
    try {
      for (const params of paramsList) {
        const result = stmt.run(...params);
        totalAffected += result.changes;
        if (result.lastInsertRowid) {
          lastId = result.lastInsertRowid;
          this._lastInsertId = result.lastInsertRowid;
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    return { totalAffected, lastInsertId: lastId };
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    return (params ? stmt.all(...params) : stmt.all()) as T[];
  }

  fetch<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): T[] {
    let effectiveSql = sql;
    if (limit !== undefined) {
      // Skip appending LIMIT when the SQL already contains one (dedup)
      const sqlBeforeComment = sql.toUpperCase().split("--")[0];
      if (!sqlBeforeComment.includes("LIMIT")) {
        effectiveSql += ` LIMIT ${limit}`;
        if (skip !== undefined && skip > 0) {
          effectiveSql += ` OFFSET ${skip}`;
        }
      }
    }
    return this.query<T>(effectiveSql, params);
  }

  fetchOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    const stmt = this.db.prepare(sql);
    const row = params ? stmt.get(...params) : stmt.get();
    return (row as T) ?? null;
  }

  insert(table: string, data: Record<string, unknown> | Record<string, unknown>[]): DatabaseResult {
    if (Array.isArray(data)) {
      if (data.length === 0) return { success: true, rowsAffected: 0 };
      const keys = Object.keys(data[0]);
      const placeholders = keys.map(() => "?").join(", ");
      const sql = `INSERT INTO "${table}" ("${keys.join('", "')}") VALUES (${placeholders})`;
      const paramsList = data.map((row) => keys.map((k) => row[k]));
      const result = this.executeMany(sql, paramsList);
      return { success: true, rowsAffected: result.totalAffected, lastInsertId: result.lastInsertId };
    }

    const keys = Object.keys(data);
    const placeholders = keys.map(() => "?").join(", ");
    const sql = `INSERT INTO "${table}" ("${keys.join('", "')}") VALUES (${placeholders})`;
    const values = Object.values(data);

    try {
      const result = this.db.prepare(sql).run(...values);
      this._lastInsertId = result.lastInsertRowid;
      return { success: true, rowsAffected: result.changes, lastInsertId: result.lastInsertRowid };
    } catch (e) {
      return { success: false, rowsAffected: 0, error: (e as Error).message };
    }
  }

  update(table: string, data: Record<string, unknown>, filter: Record<string, unknown>, params?: unknown[]): DatabaseResult {
    const setClauses = Object.keys(data).map((k) => `"${k}" = ?`).join(", ");
    const whereClauses = Object.keys(filter).map((k) => `"${k}" = ?`).join(" AND ");
    const sql = `UPDATE "${table}" SET ${setClauses} WHERE ${whereClauses}`;
    const values = [...Object.values(data), ...Object.values(filter)];

    try {
      const result = this.db.prepare(sql).run(...values);
      return { success: true, rowsAffected: result.changes };
    } catch (e) {
      return { success: false, rowsAffected: 0, error: (e as Error).message };
    }
  }

  delete(table: string, filter: Record<string, unknown> | string | Record<string, unknown>[], params?: unknown[]): DatabaseResult {
    if (Array.isArray(filter)) {
      let totalAffected = 0;
      for (const row of filter) {
        const result = this.delete(table, row);
        totalAffected += result.rowsAffected;
      }
      return { success: true, rowsAffected: totalAffected };
    }

    if (typeof filter === "string") {
      const sql = filter ? `DELETE FROM "${table}" WHERE ${filter}` : `DELETE FROM "${table}"`;
      try {
        const result = this.db.prepare(sql).run(...(params ?? []));
        return { success: true, rowsAffected: result.changes };
      } catch (e) {
        return { success: false, rowsAffected: 0, error: (e as Error).message };
      }
    }

    const whereClauses = Object.keys(filter).map((k) => `"${k}" = ?`).join(" AND ");
    const sql = `DELETE FROM "${table}" WHERE ${whereClauses}`;
    const values = Object.values(filter);

    try {
      const result = this.db.prepare(sql).run(...values);
      return { success: true, rowsAffected: result.changes };
    } catch (e) {
      return { success: false, rowsAffected: 0, error: (e as Error).message };
    }
  }

  private _inTransaction = false;

  startTransaction(): void {
    if (this._inTransaction) return;
    this.db.exec("BEGIN TRANSACTION");
    this._inTransaction = true;
  }

  commit(): void {
    if (!this._inTransaction) return;
    this.db.exec("COMMIT");
    this._inTransaction = false;
  }

  rollback(): void {
    if (!this._inTransaction) return;
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // Rollback may fail if transaction already ended
    }
    this._inTransaction = false;
  }

  tables(): string[] {
    const rows = this.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    return rows.map((r) => r.name);
  }

  columns(table: string): ColumnInfo[] {
    // v3.13.14 (#48): a SQLite "schema" is an ATTACH alias ("extra.widget").
    // PRAGMA accepts a schema prefix when both parts are plain identifiers.
    const [schema, tbl] = SQLTranslator.splitSchema(table);
    const pragma =
      schema && isIdentifier(schema) && isIdentifier(tbl)
        ? `PRAGMA ${schema}.table_info("${tbl}")`
        : `PRAGMA table_info("${table}")`;
    const rows = this.db.prepare(pragma).all() as Array<{
      name: string; type: string; notnull: number; dflt_value: unknown; pk: number;
    }>;
    return rows.map((r) => ({
      name: r.name, type: r.type, nullable: r.notnull === 0, default: r.dflt_value, primaryKey: r.pk === 1,
    }));
  }

  lastInsertId(): number | bigint | null { return this._lastInsertId; }
  close(): void { this.db.close(); }

  tableExists(name: string): boolean {
    // v3.13.14 (#48): a SQLite "schema" is an ATTACH alias ("extra.widget").
    // Query that database's own sqlite_master when the prefix is a plain
    // identifier; otherwise treat the whole string as a bare table name.
    const [schema, tbl] = SQLTranslator.splitSchema(name);
    const master = schema && isIdentifier(schema) ? `${schema}.sqlite_master` : "sqlite_master";
    const result = this.db
      .prepare(`SELECT name FROM ${master} WHERE type='table' AND name=?`)
      .get(tbl);
    return !!result;
  }

  createTable(name: string, columns: Record<string, FieldDefinition>): void {
    const colDefs: string[] = [];
    for (const [colName, def] of Object.entries(columns)) {
      const sqlType = fieldTypeToSQLite(def.type);
      const parts = [`"${colName}" ${sqlType}`];
      if (def.primaryKey) parts.push("PRIMARY KEY");
      if (def.autoIncrement) parts.push("AUTOINCREMENT");
      if (def.required && !def.primaryKey) parts.push("NOT NULL");
      if (def.default !== undefined && def.default !== "now") parts.push(`DEFAULT ${sqlDefault(def.default)}`);
      if (def.default === "now") parts.push("DEFAULT CURRENT_TIMESTAMP");
      colDefs.push(parts.join(" "));
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${colDefs.join(", ")})`);
  }

  getTableColumns(name: string): Array<{ name: string; type: string }> {
    return this.db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string; type: string }>;
  }

  addColumn(table: string, colName: string, def: FieldDefinition): void {
    const sqlType = fieldTypeToSQLite(def.type);
    let sql = `ALTER TABLE "${table}" ADD COLUMN "${colName}" ${sqlType}`;
    if (def.default !== undefined && def.default !== "now") sql += ` DEFAULT ${sqlDefault(def.default)}`;
    else if (def.default === "now") sql += " DEFAULT CURRENT_TIMESTAMP";
    this.db.exec(sql);
  }
}

function fieldTypeToSQLite(type: string): string {
  switch (type) {
    case "integer": return "INTEGER";
    case "number": case "numeric": return "REAL";
    case "boolean": return "INTEGER";
    case "datetime": return "TEXT";
    case "text": return "TEXT";
    case "string": default: return "TEXT";
  }
}

function sqlDefault(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}
