/**
 * Tina4 Firebird Adapter — uses the `node-firebird` package (optional peer dependency).
 *
 * Install: npm install node-firebird
 * URL format: firebird://user:pass@host:port/path/to/database.fdb
 */
import type { DatabaseAdapter, DatabaseResult, ColumnInfo, FieldDefinition } from "../types.js";
import { SQLTranslator } from "../sqlTranslation.js";

let firebird: any = null;

function requireFirebird(): any {
  if (firebird) return firebird;
  try {
    const { createRequire } = require("node:module") as typeof import("node:module");
    const req = createRequire(import.meta.url);
    firebird = req("node-firebird");
    return firebird;
  } catch {
    throw new Error(
      'Firebird adapter requires the "node-firebird" package. Install it with: npm install node-firebird',
    );
  }
}

export interface FirebirdConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  role?: string;
  pageSize?: number;
}

export class FirebirdAdapter implements DatabaseAdapter {
  private db: any = null;
  private transaction: any = null;
  private _lastInsertId: number | bigint | null = null;

  constructor(private config: FirebirdConfig | string) {}

  /** Connect to Firebird. Must be called before using the adapter. */
  async connect(): Promise<void> {
    const fb = requireFirebird();

    let fbConfig: any;

    if (typeof this.config === "string") {
      const parsed = this.parseUrl(this.config);
      fbConfig = {
        host: parsed.host ?? "localhost",
        port: parsed.port ?? 3050,
        database: parsed.database,
        user: parsed.user ?? "SYSDBA",
        password: parsed.password ?? "masterkey",
        role: undefined,
        pageSize: 4096,
      };
    } else {
      fbConfig = {
        host: this.config.host ?? "localhost",
        port: this.config.port ?? 3050,
        database: this.config.database,
        user: this.config.user ?? "SYSDBA",
        password: this.config.password ?? "masterkey",
        role: this.config.role,
        pageSize: this.config.pageSize ?? 4096,
      };
    }

    await new Promise<void>((resolve, reject) => {
      fb.attach(fbConfig, (err: Error | null, db: any) => {
        if (err) reject(err);
        else {
          this.db = db;
          resolve();
        }
      });
    });
  }

  private parseUrl(url: string): { host?: string; port?: number; user?: string; password?: string; database?: string } {
    // firebird://user:pass@host:port/path/to/db.fdb
    const match = url.match(/firebird:\/\/(?:([^:]+):([^@]+)@)?([^:/]+)(?::(\d+))?\/(.*)/);
    if (match) {
      return {
        user: match[1],
        password: match[2],
        host: match[3],
        port: match[4] ? parseInt(match[4], 10) : undefined,
        database: "/" + match[5],
      };
    }
    // Bare path
    const barePath = url.replace(/^firebird:\/\//, "");
    return { database: barePath };
  }

  private ensureConnected(): void {
    if (!this.db) {
      throw new Error("Firebird adapter not connected. Call connect() first.");
    }
  }

  /** Translate SQL for Firebird dialect. */
  translateSql(sql: string): string {
    let translated = SQLTranslator.limitToRows(sql);
    translated = SQLTranslator.booleanToInt(translated);
    translated = SQLTranslator.ilikeToLike(translated);
    return translated;
  }

  private queryPromise(sql: string, params?: unknown[]): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const translated = this.translateSql(sql);
      this.db.query(translated, params ?? [], (err: Error | null, result: any[]) => {
        if (err) reject(err);
        else resolve(result ?? []);
      });
    });
  }

  private executePromise(sql: string, params?: unknown[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const translated = this.translateSql(sql);
      this.db.execute(translated, params ?? [], (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  execute(sql: string, params?: unknown[]): unknown {
    throw new Error("Use executeAsync() for Firebird — async adapter requires async methods.");
  }

  async executeAsync(sql: string, params?: unknown[]): Promise<unknown> {
    this.ensureConnected();
    await this.executePromise(sql, params);
    return undefined;
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    throw new Error("Use queryAsync() for Firebird.");
  }

  async queryAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    this.ensureConnected();
    const rows = await this.queryPromise(sql, params);
    return rows as T[];
  }

  fetch<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): T[] {
    throw new Error("Use fetchAsync() for Firebird.");
  }

  async fetchAsync<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): Promise<T[]> {
    let effectiveSql = sql;
    if (limit !== undefined) {
      const offset = skip ?? 0;
      const start = offset + 1;
      const end = offset + limit;
      // Firebird uses ROWS X TO Y (or FIRST/SKIP)
      effectiveSql += ` ROWS ${start} TO ${end}`;
    }
    return this.queryAsync<T>(effectiveSql, params);
  }

  fetchOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    throw new Error("Use fetchOneAsync() for Firebird.");
  }

  async fetchOneAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    const rows = await this.fetchAsync<T>(sql, params, 1, 0);
    return rows[0] ?? null;
  }

  insert(table: string, data: Record<string, unknown>): DatabaseResult {
    throw new Error("Use insertAsync() for Firebird.");
  }

  async insertAsync(table: string, data: Record<string, unknown>): Promise<DatabaseResult> {
    this.ensureConnected();
    const keys = Object.keys(data);
    const placeholders = keys.map(() => "?").join(", ");
    const sql = `INSERT INTO "${table}" ("${keys.join('", "')}") VALUES (${placeholders})`;
    const values = Object.values(data);

    try {
      await this.executePromise(sql, values);
      // Firebird doesn't have a generic last_insert_id — return success without id
      return {
        success: true,
        rowsAffected: 1,
      };
    } catch (e) {
      return { success: false, rowsAffected: 0, error: (e as Error).message };
    }
  }

  update(table: string, data: Record<string, unknown>, filter: Record<string, unknown>): DatabaseResult {
    throw new Error("Use updateAsync() for Firebird.");
  }

  async updateAsync(table: string, data: Record<string, unknown>, filter: Record<string, unknown>): Promise<DatabaseResult> {
    this.ensureConnected();
    const setClauses = Object.keys(data).map((k) => `"${k}" = ?`).join(", ");
    const whereClauses = Object.keys(filter).map((k) => `"${k}" = ?`).join(" AND ");
    const sql = `UPDATE "${table}" SET ${setClauses} WHERE ${whereClauses}`;
    const values = [...Object.values(data), ...Object.values(filter)];

    try {
      await this.executePromise(sql, values);
      return { success: true, rowsAffected: 1 };
    } catch (e) {
      return { success: false, rowsAffected: 0, error: (e as Error).message };
    }
  }

  delete(table: string, filter: Record<string, unknown>): DatabaseResult {
    throw new Error("Use deleteAsync() for Firebird.");
  }

  async deleteAsync(table: string, filter: Record<string, unknown>): Promise<DatabaseResult> {
    this.ensureConnected();
    const whereClauses = Object.keys(filter).map((k) => `"${k}" = ?`).join(" AND ");
    const sql = `DELETE FROM "${table}" WHERE ${whereClauses}`;
    const values = Object.values(filter);

    try {
      await this.executePromise(sql, values);
      return { success: true, rowsAffected: 1 };
    } catch (e) {
      return { success: false, rowsAffected: 0, error: (e as Error).message };
    }
  }

  startTransaction(): void {
    throw new Error("Use startTransactionAsync() for Firebird.");
  }

  async startTransactionAsync(): Promise<void> {
    this.ensureConnected();
    await new Promise<void>((resolve, reject) => {
      this.db.transaction(0 /* ISOLATION_READ_COMMITTED */, (err: Error | null, transaction: any) => {
        if (err) reject(err);
        else {
          this.transaction = transaction;
          resolve();
        }
      });
    });
  }

  commit(): void {
    throw new Error("Use commitAsync() for Firebird.");
  }

  async commitAsync(): Promise<void> {
    if (!this.transaction) throw new Error("No active transaction to commit.");
    await new Promise<void>((resolve, reject) => {
      this.transaction.commit((err: Error | null) => {
        if (err) reject(err);
        else {
          this.transaction = null;
          resolve();
        }
      });
    });
  }

  rollback(): void {
    throw new Error("Use rollbackAsync() for Firebird.");
  }

  async rollbackAsync(): Promise<void> {
    if (!this.transaction) throw new Error("No active transaction to rollback.");
    await new Promise<void>((resolve, reject) => {
      this.transaction.rollback((err: Error | null) => {
        if (err) reject(err);
        else {
          this.transaction = null;
          resolve();
        }
      });
    });
  }

  tables(): string[] {
    throw new Error("Use tablesAsync() for Firebird.");
  }

  async tablesAsync(): Promise<string[]> {
    const rows = await this.queryAsync<Record<string, string>>(
      "SELECT RDB$RELATION_NAME FROM RDB$RELATIONS WHERE RDB$SYSTEM_FLAG = 0 AND RDB$VIEW_BLR IS NULL",
    );
    return rows.map((r) => {
      const name = r["RDB$RELATION_NAME"] ?? r["rdb$relation_name"] ?? "";
      return typeof name === "string" ? name.trim() : String(name).trim();
    });
  }

  columns(table: string): ColumnInfo[] {
    throw new Error("Use columnsAsync() for Firebird.");
  }

  async columnsAsync(table: string): Promise<ColumnInfo[]> {
    const rows = await this.queryAsync<Record<string, unknown>>(
      `SELECT RF.RDB$FIELD_NAME, F.RDB$FIELD_TYPE, RF.RDB$NULL_FLAG, RF.RDB$DEFAULT_SOURCE
       FROM RDB$RELATION_FIELDS RF
       JOIN RDB$FIELDS F ON RF.RDB$FIELD_SOURCE = F.RDB$FIELD_NAME
       WHERE RF.RDB$RELATION_NAME = ?`,
      [table.toUpperCase()],
    );
    return rows.map((r) => {
      const name = (r["RDB$FIELD_NAME"] ?? r["rdb$field_name"] ?? "") as string;
      return {
        name: typeof name === "string" ? name.trim() : String(name).trim(),
        type: firebirdFieldTypeToString(r["RDB$FIELD_TYPE"] ?? r["rdb$field_type"]),
        nullable: (r["RDB$NULL_FLAG"] ?? r["rdb$null_flag"]) === null,
        default: r["RDB$DEFAULT_SOURCE"] ?? r["rdb$default_source"],
        primaryKey: false,
      };
    });
  }

  lastInsertId(): number | bigint | null {
    // Firebird doesn't have a generic last_insert_id
    return this._lastInsertId;
  }

  close(): void {
    if (this.db) {
      this.db.detach();
      this.db = null;
    }
  }

  tableExists(name: string): boolean {
    throw new Error("Use tableExistsAsync() for Firebird.");
  }

  async tableExistsAsync(name: string): Promise<boolean> {
    const rows = await this.queryAsync<Record<string, unknown>>(
      "SELECT RDB$RELATION_NAME FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = ?",
      [name.toUpperCase()],
    );
    return rows.length > 0;
  }

  createTable(name: string, columns: Record<string, FieldDefinition>): void {
    throw new Error("Use createTableAsync() for Firebird.");
  }

  async createTableAsync(name: string, columns: Record<string, FieldDefinition>): Promise<void> {
    // Check if table exists first — Firebird doesn't support IF NOT EXISTS on CREATE TABLE
    const exists = await this.tableExistsAsync(name);
    if (exists) return;

    const colDefs: string[] = [];

    for (const [colName, def] of Object.entries(columns)) {
      const sqlType = fieldTypeToFirebird(def);
      const parts = [`"${colName}" ${sqlType}`];

      if (def.primaryKey && !def.autoIncrement) parts.push("PRIMARY KEY");
      if (def.required && !def.primaryKey) parts.push("NOT NULL");
      if (def.default !== undefined && def.default !== "now") {
        parts.push(`DEFAULT ${sqlDefault(def.default)}`);
      }
      if (def.default === "now") {
        parts.push("DEFAULT CURRENT_TIMESTAMP");
      }

      colDefs.push(parts.join(" "));
    }

    const sql = `CREATE TABLE "${name}" (${colDefs.join(", ")})`;
    await this.executeAsync(sql);

    // Create sequences and triggers for auto-increment columns
    for (const [colName, def] of Object.entries(columns)) {
      if (def.autoIncrement) {
        const seqName = `GEN_${name}_${colName}`.toUpperCase();
        const trigName = `TRG_${name}_${colName}`.toUpperCase();

        await this.executeAsync(`CREATE SEQUENCE "${seqName}"`);
        await this.executeAsync(
          `CREATE TRIGGER "${trigName}" FOR "${name}" ACTIVE BEFORE INSERT POSITION 0 AS BEGIN IF (NEW."${colName}" IS NULL) THEN NEW."${colName}" = NEXT VALUE FOR "${seqName}"; END`,
        );
      }
    }
  }
}

/** Convert Firebird internal field type codes to strings. */
function firebirdFieldTypeToString(typeCode: unknown): string {
  switch (typeCode) {
    case 7: return "SMALLINT";
    case 8: return "INTEGER";
    case 10: return "FLOAT";
    case 12: return "DATE";
    case 13: return "TIME";
    case 14: return "CHAR";
    case 16: return "BIGINT";
    case 27: return "DOUBLE PRECISION";
    case 35: return "TIMESTAMP";
    case 37: return "VARCHAR";
    case 261: return "BLOB";
    default: return String(typeCode);
  }
}

function fieldTypeToFirebird(def: FieldDefinition): string {
  if (def.primaryKey && def.autoIncrement) {
    return "INTEGER PRIMARY KEY";
  }
  switch (def.type) {
    case "integer":
      return "INTEGER";
    case "number":
    case "numeric":
      return "DOUBLE PRECISION";
    case "boolean":
      return "SMALLINT";
    case "datetime":
      return "TIMESTAMP";
    case "text":
      return "BLOB SUB_TYPE TEXT";
    case "string":
      return def.maxLength ? `VARCHAR(${def.maxLength})` : "VARCHAR(255)";
    default:
      return "VARCHAR(255)";
  }
}

function sqlDefault(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}
