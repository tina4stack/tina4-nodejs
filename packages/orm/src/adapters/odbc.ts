/**
 * Tina4 ODBC Adapter — uses the `odbc` package (optional peer dependency).
 *
 * Install: npm install odbc
 * URL format: odbc:///DSN=MyDSN
 *             odbc:///DRIVER={driver};SERVER=host;DATABASE=db
 *
 * The connection string after stripping the "odbc:///" prefix is passed
 * directly to odbc.connect(), so any valid ODBC connection string works.
 */
import type { DatabaseAdapter, DatabaseResult, ColumnInfo, FieldDefinition } from "../types.js";
import { createRequire } from "node:module";

let odbcModule: any = null;

function requireOdbc(): any {
  if (odbcModule) return odbcModule;
  try {
    const req = createRequire(import.meta.url);
    odbcModule = req("odbc");
    return odbcModule;
  } catch {
    throw new Error(
      "The 'odbc' package is required for ODBC connections. Install one of:\n" +
        "    npm install odbc\n" +
        "    yarn add odbc\n" +
        "    pnpm add odbc\n" +
        "    bun add odbc",
    );
  }
}

export interface OdbcConfig {
  /** Full ODBC connection string, e.g. "DSN=MyDSN" or "DRIVER={SQL Server};SERVER=host;DATABASE=db" */
  connectionString: string;
}

export class OdbcAdapter implements DatabaseAdapter {
  private connection: any = null;
  private _lastInsertId: number | bigint | null = null;
  private _inTransaction: boolean = false;

  /**
   * Accepts either an OdbcConfig object or a raw connection string.
   * When created via Database.create("odbc:///DSN=MyDSN"), the "odbc:///"
   * prefix is stripped by parseDatabaseUrl and the remainder is passed here.
   */
  constructor(private config: OdbcConfig | string) {}

  /** Extract the raw ODBC connection string from config. */
  private getConnectionString(): string {
    if (typeof this.config === "string") return this.config;
    return this.config.connectionString;
  }

  /** Connect to the ODBC data source. Must be called before using the adapter. */
  async connect(): Promise<void> {
    const odbc = requireOdbc();
    const connStr = this.getConnectionString();
    // odbc package may expose connect as default export or named export
    const connectFn = odbc.connect ?? odbc.default?.connect;
    if (!connectFn) {
      throw new Error("odbc module does not export a connect() function. Check your odbc package version.");
    }
    this.connection = await connectFn(connStr);
  }

  private ensureConnected(): void {
    if (!this.connection) {
      throw new Error("ODBC adapter not connected. Call connect() first.");
    }
  }

  // -------------------------------------------------------------------------
  // Synchronous interface stubs — ODBC is async; use the *Async variants
  // -------------------------------------------------------------------------

  execute(sql: string, params?: unknown[]): unknown {
    throw new Error("Use executeAsync() for ODBC — async adapter requires async methods.");
  }

  executeMany(sql: string, paramsList: unknown[][]): { totalAffected: number; lastInsertId?: number | bigint } {
    throw new Error("Use executeManyAsync() for ODBC — async adapter requires async methods.");
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    throw new Error("Use queryAsync() for ODBC — async adapter requires async methods.");
  }

  fetch<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): T[] {
    throw new Error("Use fetchAsync() for ODBC — async adapter requires async methods.");
  }

  fetchOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    throw new Error("Use fetchOneAsync() for ODBC — async adapter requires async methods.");
  }

  insert(table: string, data: Record<string, unknown>): DatabaseResult {
    throw new Error("Use insertAsync() for ODBC — async adapter requires async methods.");
  }

  update(table: string, data: Record<string, unknown>, filter: Record<string, unknown>): DatabaseResult {
    throw new Error("Use updateAsync() for ODBC — async adapter requires async methods.");
  }

  delete(table: string, filter: Record<string, unknown> | string | Record<string, unknown>[]): DatabaseResult {
    throw new Error("Use deleteAsync() for ODBC — async adapter requires async methods.");
  }

  startTransaction(): void {
    throw new Error("Use startTransactionAsync() for ODBC — async adapter requires async methods.");
  }

  commit(): void {
    throw new Error("Use commitAsync() for ODBC — async adapter requires async methods.");
  }

  rollback(): void {
    throw new Error("Use rollbackAsync() for ODBC — async adapter requires async methods.");
  }

  tables(): string[] {
    throw new Error("Use tablesAsync() for ODBC — async adapter requires async methods.");
  }

  columns(table: string): ColumnInfo[] {
    throw new Error("Use columnsAsync() for ODBC — async adapter requires async methods.");
  }

  tableExists(name: string): boolean {
    throw new Error("Use tableExistsAsync() for ODBC — async adapter requires async methods.");
  }

  createTable(name: string, columns: Record<string, FieldDefinition>): void {
    throw new Error("Use createTableAsync() for ODBC — async adapter requires async methods.");
  }

  getTableColumns(name: string): Array<{ name: string; type: string }> {
    throw new Error("Use getTableColumnsAsync() for ODBC — async adapter requires async methods.");
  }

  addColumn(table: string, colName: string, def: FieldDefinition): void {
    throw new Error("Use addColumnAsync() for ODBC — async adapter requires async methods.");
  }

  // -------------------------------------------------------------------------
  // Async methods — primary API for ODBC
  // -------------------------------------------------------------------------

  /** Execute a write statement (INSERT, UPDATE, DELETE, DDL). */
  async executeAsync(sql: string, params?: unknown[]): Promise<unknown> {
    this.ensureConnected();
    const result = await this.connection.query(sql, params ?? []);
    // Try to capture last insert id from result metadata if present
    if (result && typeof result === "object" && "lastInsertId" in result) {
      this._lastInsertId = (result as any).lastInsertId;
    }
    return result;
  }

  /** Execute a statement with multiple parameter sets inside a single transaction. */
  async executeManyAsync(sql: string, paramsList: unknown[][]): Promise<{ totalAffected: number; lastInsertId?: number | bigint }> {
    this.ensureConnected();
    let totalAffected = 0;
    let lastId: number | bigint | undefined;

    await this.startTransactionAsync();
    try {
      for (const params of paramsList) {
        await this.connection.query(sql, params);
        totalAffected++;
      }
      await this.commitAsync();
    } catch (e) {
      await this.rollbackAsync();
      throw e;
    }

    if (lastId !== undefined) this._lastInsertId = lastId;
    return { totalAffected, lastInsertId: lastId };
  }

  /** Run a SELECT and return all matching rows. */
  async queryAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    this.ensureConnected();
    const result = await this.connection.query(sql, params ?? []);
    // odbc returns an array-like result object; spread into a plain array
    return Array.from(result) as T[];
  }

  /** Run a SELECT with optional LIMIT/OFFSET pagination. */
  async fetchAsync<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    limit?: number,
    skip?: number,
  ): Promise<T[]> {
    let effectiveSql = sql;
    if (limit !== undefined) {
      const sqlUpper = sql.toUpperCase().split("--")[0];
      if (!sqlUpper.includes("LIMIT")) {
        effectiveSql += ` LIMIT ${limit}`;
        if (skip !== undefined && skip > 0) {
          effectiveSql += ` OFFSET ${skip}`;
        }
      }
    }
    return this.queryAsync<T>(effectiveSql, params);
  }

  /** Run a SELECT and return the first row or null. */
  async fetchOneAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    const rows = await this.queryAsync<T>(sql, params);
    return rows[0] ?? null;
  }

  /** Insert a single row into a table. */
  async insertAsync(table: string, data: Record<string, unknown>): Promise<DatabaseResult> {
    this.ensureConnected();
    const keys = Object.keys(data);
    const placeholders = keys.map(() => "?").join(", ");
    const sql = `INSERT INTO "${table}" ("${keys.join('", "')}") VALUES (${placeholders})`;
    const values = Object.values(data);

    try {
      await this.connection.query(sql, values);
      return { success: true, rowsAffected: 1, lastInsertId: this._lastInsertId ?? undefined };
    } catch (e) {
      return { success: false, rowsAffected: 0, error: (e as Error).message };
    }
  }

  /** Update rows in a table matching filter. */
  async updateAsync(table: string, data: Record<string, unknown>, filter: Record<string, unknown>): Promise<DatabaseResult> {
    this.ensureConnected();
    const setClauses = Object.keys(data).map((k) => `"${k}" = ?`).join(", ");
    const whereClauses = Object.keys(filter).map((k) => `"${k}" = ?`).join(" AND ");
    const sql = `UPDATE "${table}" SET ${setClauses} WHERE ${whereClauses}`;
    const values = [...Object.values(data), ...Object.values(filter)];

    try {
      await this.connection.query(sql, values);
      return { success: true, rowsAffected: 1 };
    } catch (e) {
      return { success: false, rowsAffected: 0, error: (e as Error).message };
    }
  }

  /** Delete rows from a table. */
  async deleteAsync(
    table: string,
    filter: Record<string, unknown> | string | Record<string, unknown>[],
  ): Promise<DatabaseResult> {
    this.ensureConnected();

    if (Array.isArray(filter)) {
      let totalAffected = 0;
      for (const row of filter) {
        const result = await this.deleteAsync(table, row);
        totalAffected += result.rowsAffected;
      }
      return { success: true, rowsAffected: totalAffected };
    }

    if (typeof filter === "string") {
      const sql = filter
        ? `DELETE FROM "${table}" WHERE ${filter}`
        : `DELETE FROM "${table}"`;
      try {
        await this.connection.query(sql, []);
        return { success: true, rowsAffected: 1 };
      } catch (e) {
        return { success: false, rowsAffected: 0, error: (e as Error).message };
      }
    }

    const whereClauses = Object.keys(filter).map((k) => `"${k}" = ?`).join(" AND ");
    const sql = `DELETE FROM "${table}" WHERE ${whereClauses}`;
    const values = Object.values(filter);

    try {
      await this.connection.query(sql, values);
      return { success: true, rowsAffected: 1 };
    } catch (e) {
      return { success: false, rowsAffected: 0, error: (e as Error).message };
    }
  }

  /** Begin a transaction. */
  async startTransactionAsync(): Promise<void> {
    if (this._inTransaction) return;
    this.ensureConnected();
    // odbc connections have beginTransaction() method
    await this.connection.beginTransaction();
    this._inTransaction = true;
  }

  /** Commit the current transaction. */
  async commitAsync(): Promise<void> {
    if (!this._inTransaction) return;
    this.ensureConnected();
    await this.connection.commit();
    this._inTransaction = false;
  }

  /** Rollback the current transaction. */
  async rollbackAsync(): Promise<void> {
    if (!this._inTransaction) return;
    this.ensureConnected();
    try {
      await this.connection.rollback();
    } catch {
      // Rollback may fail if transaction already ended
    }
    this._inTransaction = false;
  }

  /** List all user tables using ODBC catalog functions. */
  async tablesAsync(): Promise<string[]> {
    this.ensureConnected();
    // odbc.Connection.tables(catalog, schema, table, type) returns catalog rows
    const rows: any[] = await this.connection.tables(null, null, null, "TABLE");
    return rows.map((r: any) => r.TABLE_NAME ?? r.table_name ?? r.name).filter(Boolean);
  }

  /** Get column metadata for a table using ODBC catalog functions. */
  async columnsAsync(table: string): Promise<ColumnInfo[]> {
    this.ensureConnected();
    // odbc.Connection.columns(catalog, schema, table, column)
    const rows: any[] = await this.connection.columns(null, null, table, null);
    return rows.map((r: any) => ({
      name: r.COLUMN_NAME ?? r.column_name,
      type: r.TYPE_NAME ?? r.type_name ?? r.DATA_TYPE ?? "",
      nullable: (r.NULLABLE ?? r.nullable) === 1,
      default: r.COLUMN_DEF ?? r.column_def ?? null,
      primaryKey: false, // ODBC catalog doesn't easily expose PK; requires separate primaryKeys() call
    }));
  }

  /** Check whether a table exists. */
  async tableExistsAsync(name: string): Promise<boolean> {
    this.ensureConnected();
    const rows: any[] = await this.connection.tables(null, null, name, "TABLE");
    return rows.length > 0;
  }

  /** Create a table from a FieldDefinition map. Uses generic SQL — works with most ODBC sources. */
  async createTableAsync(name: string, columns: Record<string, FieldDefinition>): Promise<void> {
    const colDefs: string[] = [];
    for (const [colName, def] of Object.entries(columns)) {
      const sqlType = fieldTypeToOdbc(def.type);
      const parts = [`"${colName}" ${sqlType}`];
      if (def.primaryKey) parts.push("PRIMARY KEY");
      if (def.autoIncrement) parts.push("GENERATED ALWAYS AS IDENTITY"); // ANSI SQL
      if (def.required && !def.primaryKey) parts.push("NOT NULL");
      if (def.default !== undefined && def.default !== "now") {
        parts.push(`DEFAULT ${sqlDefault(def.default)}`);
      }
      if (def.default === "now") parts.push("DEFAULT CURRENT_TIMESTAMP");
      colDefs.push(parts.join(" "));
    }
    await this.connection.query(`CREATE TABLE IF NOT EXISTS "${name}" (${colDefs.join(", ")})`);
  }

  /** Get raw column name+type list for a table. */
  async getTableColumnsAsync(name: string): Promise<Array<{ name: string; type: string }>> {
    const cols = await this.columnsAsync(name);
    return cols.map((c) => ({ name: c.name, type: c.type }));
  }

  /** Add a column to an existing table. */
  async addColumnAsync(table: string, colName: string, def: FieldDefinition): Promise<void> {
    const sqlType = fieldTypeToOdbc(def.type);
    let sql = `ALTER TABLE "${table}" ADD COLUMN "${colName}" ${sqlType}`;
    if (def.default !== undefined && def.default !== "now") {
      sql += ` DEFAULT ${sqlDefault(def.default)}`;
    } else if (def.default === "now") {
      sql += " DEFAULT CURRENT_TIMESTAMP";
    }
    await this.connection.query(sql);
  }

  lastInsertId(): number | bigint | null {
    return this._lastInsertId;
  }

  close(): void {
    if (this.connection) {
      // odbc close is async but we keep the sync interface — fire and forget
      this.connection.close().catch(() => {});
      this.connection = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fieldTypeToOdbc(type: string): string {
  switch (type) {
    case "integer": return "INTEGER";
    case "number":
    case "numeric": return "DOUBLE PRECISION";
    case "boolean": return "SMALLINT";
    case "datetime": return "TIMESTAMP";
    case "text": return "CLOB";
    case "string":
    default: return "VARCHAR(255)";
  }
}

function sqlDefault(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}
