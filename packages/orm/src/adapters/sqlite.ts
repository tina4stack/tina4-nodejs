import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseAdapter, FieldDefinition } from "../types.js";

export class SQLiteAdapter implements DatabaseAdapter {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Create directory if needed
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  execute(sql: string, params?: unknown[]): unknown {
    const stmt = this.db.prepare(sql);
    return params ? stmt.run(...params) : stmt.run();
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    return (params ? stmt.all(...params) : stmt.all()) as T[];
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
