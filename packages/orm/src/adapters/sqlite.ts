import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseAdapter, DatabaseResult, ColumnInfo, FieldDefinition } from "../types.js";

export class SQLiteAdapter implements DatabaseAdapter {
  private db: Database.Database;
  private _lastInsertId: number | bigint | null = null;

  constructor(dbPath: string) {
    // Create directory if needed
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  execute(sql: string, params?: unknown[]): unknown {
    const stmt = this.db.prepare(sql);
    const result = params ? stmt.run(...params) : stmt.run();
    if (result && typeof result === "object" && "lastInsertRowid" in result) {
      this._lastInsertId = result.lastInsertRowid as number | bigint;
    }
    return result;
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    return (params ? stmt.all(...params) : stmt.all()) as T[];
  }

  fetch<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): T[] {
    let effectiveSql = sql;
    if (limit !== undefined) {
      effectiveSql += ` LIMIT ${limit}`;
      if (skip !== undefined && skip > 0) {
        effectiveSql += ` OFFSET ${skip}`;
      }
    }
    return this.query<T>(effectiveSql, params);
  }

  fetchOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    const stmt = this.db.prepare(sql);
    const row = params ? stmt.get(...params) : stmt.get();
    return (row as T) ?? null;
  }

  insert(table: string, data: Record<string, unknown>): DatabaseResult {
    const keys = Object.keys(data);
    const placeholders = keys.map(() => "?").join(", ");
    const sql = `INSERT INTO "${table}" ("${keys.join('", "')}") VALUES (${placeholders})`;
    const values = Object.values(data);

    try {
      const result = this.db.prepare(sql).run(...values);
      this._lastInsertId = result.lastInsertRowid;
      return {
        success: true,
        rowsAffected: result.changes,
        lastInsertId: result.lastInsertRowid,
      };
    } catch (e) {
      return {
        success: false,
        rowsAffected: 0,
        error: (e as Error).message,
      };
    }
  }

  update(table: string, data: Record<string, unknown>, filter: Record<string, unknown>): DatabaseResult {
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

  delete(table: string, filter: Record<string, unknown>): DatabaseResult {
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

  startTransaction(): void {
    this.db.exec("BEGIN TRANSACTION");
  }

  commit(): void {
    this.db.exec("COMMIT");
  }

  rollback(): void {
    this.db.exec("ROLLBACK");
  }

  tables(): string[] {
    const rows = this.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    return rows.map((r) => r.name);
  }

  columns(table: string): ColumnInfo[] {
    const rows = this.db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;
    return rows.map((r) => ({
      name: r.name,
      type: r.type,
      nullable: r.notnull === 0,
      default: r.dflt_value,
      primaryKey: r.pk === 1,
    }));
  }

  lastInsertId(): number | bigint | null {
    return this._lastInsertId;
  }

  close(): void {
    this.db.close();
  }

  tableExists(name: string): boolean {
    const result = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
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
      if (def.default !== undefined && def.default !== "now") {
        parts.push(`DEFAULT ${sqlDefault(def.default)}`);
      }
      if (def.default === "now") {
        parts.push("DEFAULT CURRENT_TIMESTAMP");
      }

      colDefs.push(parts.join(" "));
    }

    const sql = `CREATE TABLE IF NOT EXISTS "${name}" (${colDefs.join(", ")})`;
    this.db.exec(sql);
  }

  getTableColumns(name: string): Array<{ name: string; type: string }> {
    return this.db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
      name: string;
      type: string;
    }>;
  }

  addColumn(table: string, colName: string, def: FieldDefinition): void {
    const sqlType = fieldTypeToSQLite(def.type);
    let sql = `ALTER TABLE "${table}" ADD COLUMN "${colName}" ${sqlType}`;
    if (def.default !== undefined && def.default !== "now") {
      sql += ` DEFAULT ${sqlDefault(def.default)}`;
    } else if (def.default === "now") {
      sql += " DEFAULT CURRENT_TIMESTAMP";
    }
    this.db.exec(sql);
  }
}

function fieldTypeToSQLite(type: string): string {
  switch (type) {
    case "integer":
      return "INTEGER";
    case "number":
      return "REAL";
    case "boolean":
      return "INTEGER";
    case "datetime":
      return "TEXT";
    case "text":
      return "TEXT";
    case "string":
    default:
      return "TEXT";
  }
}

function sqlDefault(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}
