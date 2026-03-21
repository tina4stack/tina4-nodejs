/**
 * Tina4 MySQL Adapter — uses the `mysql2` package (optional peer dependency).
 *
 * Install: npm install mysql2
 * URL format: mysql://user:pass@host:port/database
 */
import type { DatabaseAdapter, DatabaseResult, ColumnInfo, FieldDefinition } from "../types.js";
import { SQLTranslator } from "../sqlTranslation.js";

let mysql2: any = null;

function requireMysql2(): any {
  if (mysql2) return mysql2;
  try {
    const { createRequire } = require("node:module") as typeof import("node:module");
    const req = createRequire(import.meta.url);
    mysql2 = req("mysql2");
    return mysql2;
  } catch {
    throw new Error(
      'MySQL adapter requires the "mysql2" package. Install it with: npm install mysql2',
    );
  }
}

export interface MysqlConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  connectionString?: string;
}

export class MysqlAdapter implements DatabaseAdapter {
  private connection: any = null;
  private _lastInsertId: number | bigint | null = null;

  constructor(private config: MysqlConfig | string) {}

  /** Connect to MySQL. Must be called before using the adapter. */
  async connect(): Promise<void> {
    const mod = requireMysql2();

    if (typeof this.config === "string") {
      // Parse URL: mysql://user:pass@host:port/database
      const url = new URL(this.config);
      this.connection = mod.createConnection({
        host: url.hostname || "localhost",
        port: url.port ? parseInt(url.port, 10) : 3306,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.replace(/^\//, ""),
      });
    } else {
      this.connection = mod.createConnection({
        host: this.config.host ?? "localhost",
        port: this.config.port ?? 3306,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
      });
    }

    // Promisify the connection
    await new Promise<void>((resolve, reject) => {
      this.connection.connect((err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private ensureConnected(): void {
    if (!this.connection) {
      throw new Error("MySQL adapter not connected. Call connect() first.");
    }
  }

  private queryPromise(sql: string, params?: unknown[]): Promise<any> {
    return new Promise((resolve, reject) => {
      this.connection.query(sql, params ?? [], (err: Error | null, results: any) => {
        if (err) reject(err);
        else resolve(results);
      });
    });
  }

  /** Translate SQL for MySQL dialect. */
  translateSql(sql: string): string {
    // MySQL uses CONCAT() instead of ||
    let translated = SQLTranslator.concatPipesToFunc(sql);
    // MySQL uses LOWER() LIKE instead of ILIKE
    translated = SQLTranslator.ilikeToLike(translated);
    return translated;
  }

  execute(sql: string, params?: unknown[]): unknown {
    throw new Error("Use executeAsync() for MySQL — async adapter requires async methods.");
  }

  async executeAsync(sql: string, params?: unknown[]): Promise<unknown> {
    this.ensureConnected();
    const translated = this.translateSql(sql);
    const result = await this.queryPromise(translated, params);
    if (result?.insertId) {
      this._lastInsertId = result.insertId;
    }
    return result;
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    throw new Error("Use queryAsync() for MySQL.");
  }

  async queryAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    this.ensureConnected();
    const translated = this.translateSql(sql);
    const results = await this.queryPromise(translated, params);
    return Array.isArray(results) ? results as T[] : [];
  }

  fetch<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): T[] {
    throw new Error("Use fetchAsync() for MySQL.");
  }

  async fetchAsync<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): Promise<T[]> {
    let effectiveSql = sql;
    if (limit !== undefined) {
      effectiveSql += ` LIMIT ${limit}`;
      if (skip !== undefined && skip > 0) {
        effectiveSql += ` OFFSET ${skip}`;
      }
    }
    return this.queryAsync<T>(effectiveSql, params);
  }

  fetchOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    throw new Error("Use fetchOneAsync() for MySQL.");
  }

  async fetchOneAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    const rows = await this.queryAsync<T>(sql, params);
    return rows[0] ?? null;
  }

  insert(table: string, data: Record<string, unknown>): DatabaseResult {
    throw new Error("Use insertAsync() for MySQL.");
  }

  async insertAsync(table: string, data: Record<string, unknown>): Promise<DatabaseResult> {
    this.ensureConnected();
    const keys = Object.keys(data);
    const placeholders = keys.map(() => "?").join(", ");
    const sql = `INSERT INTO \`${table}\` (\`${keys.join("`, `")}\`) VALUES (${placeholders})`;
    const values = Object.values(data);

    try {
      const result = await this.queryPromise(sql, values);
      this._lastInsertId = result.insertId ?? null;
      return {
        success: true,
        rowsAffected: result.affectedRows ?? 1,
        lastInsertId: result.insertId,
      };
    } catch (e) {
      return { success: false, rowsAffected: 0, error: (e as Error).message };
    }
  }

  update(table: string, data: Record<string, unknown>, filter: Record<string, unknown>): DatabaseResult {
    throw new Error("Use updateAsync() for MySQL.");
  }

  async updateAsync(table: string, data: Record<string, unknown>, filter: Record<string, unknown>): Promise<DatabaseResult> {
    this.ensureConnected();
    const setClauses = Object.keys(data).map((k) => `\`${k}\` = ?`).join(", ");
    const whereClauses = Object.keys(filter).map((k) => `\`${k}\` = ?`).join(" AND ");
    const sql = `UPDATE \`${table}\` SET ${setClauses} WHERE ${whereClauses}`;
    const values = [...Object.values(data), ...Object.values(filter)];

    try {
      const result = await this.queryPromise(sql, values);
      return { success: true, rowsAffected: result.affectedRows ?? 0 };
    } catch (e) {
      return { success: false, rowsAffected: 0, error: (e as Error).message };
    }
  }

  delete(table: string, filter: Record<string, unknown>): DatabaseResult {
    throw new Error("Use deleteAsync() for MySQL.");
  }

  async deleteAsync(table: string, filter: Record<string, unknown>): Promise<DatabaseResult> {
    this.ensureConnected();
    const whereClauses = Object.keys(filter).map((k) => `\`${k}\` = ?`).join(" AND ");
    const sql = `DELETE FROM \`${table}\` WHERE ${whereClauses}`;
    const values = Object.values(filter);

    try {
      const result = await this.queryPromise(sql, values);
      return { success: true, rowsAffected: result.affectedRows ?? 0 };
    } catch (e) {
      return { success: false, rowsAffected: 0, error: (e as Error).message };
    }
  }

  startTransaction(): void {
    throw new Error("Use startTransactionAsync() for MySQL.");
  }

  async startTransactionAsync(): Promise<void> {
    await this.executeAsync("START TRANSACTION");
  }

  commit(): void {
    throw new Error("Use commitAsync() for MySQL.");
  }

  async commitAsync(): Promise<void> {
    await this.executeAsync("COMMIT");
  }

  rollback(): void {
    throw new Error("Use rollbackAsync() for MySQL.");
  }

  async rollbackAsync(): Promise<void> {
    await this.executeAsync("ROLLBACK");
  }

  tables(): string[] {
    throw new Error("Use tablesAsync() for MySQL.");
  }

  async tablesAsync(): Promise<string[]> {
    const rows = await this.queryAsync<Record<string, string>>("SHOW TABLES");
    return rows.map((r) => Object.values(r)[0]);
  }

  columns(table: string): ColumnInfo[] {
    throw new Error("Use columnsAsync() for MySQL.");
  }

  async columnsAsync(table: string): Promise<ColumnInfo[]> {
    const rows = await this.queryAsync<{
      Field: string;
      Type: string;
      Null: string;
      Default: string | null;
      Key: string;
    }>(`DESCRIBE \`${table}\``);
    return rows.map((r) => ({
      name: r.Field,
      type: r.Type,
      nullable: r.Null === "YES",
      default: r.Default,
      primaryKey: r.Key === "PRI",
    }));
  }

  lastInsertId(): number | bigint | null {
    return this._lastInsertId;
  }

  close(): void {
    if (this.connection) {
      this.connection.end();
      this.connection = null;
    }
  }

  tableExists(name: string): boolean {
    throw new Error("Use tableExistsAsync() for MySQL.");
  }

  async tableExistsAsync(name: string): Promise<boolean> {
    const rows = await this.queryAsync<Record<string, string>>(
      `SHOW TABLES LIKE ?`,
      [name],
    );
    return rows.length > 0;
  }

  createTable(name: string, columns: Record<string, FieldDefinition>): void {
    throw new Error("Use createTableAsync() for MySQL.");
  }

  async createTableAsync(name: string, columns: Record<string, FieldDefinition>): Promise<void> {
    const colDefs: string[] = [];

    for (const [colName, def] of Object.entries(columns)) {
      const sqlType = fieldTypeToMysql(def);
      const parts = [`\`${colName}\` ${sqlType}`];

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

    const sql = `CREATE TABLE IF NOT EXISTS \`${name}\` (${colDefs.join(", ")}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
    await this.executeAsync(sql);
  }
}

function fieldTypeToMysql(def: FieldDefinition): string {
  if (def.primaryKey && def.autoIncrement) {
    return "INT AUTO_INCREMENT PRIMARY KEY";
  }
  switch (def.type) {
    case "integer":
      return "INT";
    case "number":
    case "numeric":
      return "DOUBLE";
    case "boolean":
      return "TINYINT(1)";
    case "datetime":
      return "DATETIME";
    case "text":
      return "TEXT";
    case "string":
      return def.maxLength ? `VARCHAR(${def.maxLength})` : "VARCHAR(255)";
    default:
      return "TEXT";
  }
}

function sqlDefault(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}
