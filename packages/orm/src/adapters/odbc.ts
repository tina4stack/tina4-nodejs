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
import { ANSI_DIALECT, buildInsert, buildSetClause, buildWhereClause } from "./sqlDialect.js";
import type { DatabaseAdapter, DatabaseResult, ColumnInfo, FieldDefinition } from "../types.js";
import { createRequire } from "node:module";
import { SQLTranslator } from "../sqlTranslator.js";
import { connectTimeoutMillis, withConnectTimeout } from "../connectTimeout.js";

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
  /** Optional username; appended as UID when not already in the connection string. */
  username?: string;
  /** Optional password; appended as PWD when not already in the connection string. */
  password?: string;
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

  /**
   * The connection string with credentials applied. ODBC has no separate-
   * credentials API (odbc.connect() reads only the string), so a username/
   * password passed to Database.create() must be folded in as UID/PWD - the
   * adapter used to drop them. Never used for diagnostics (describeTarget reads
   * the raw string), so the password never reaches an error message.
   */
  private effectiveConnectionString(): string {
    let connStr = this.getConnectionString();
    if (typeof this.config === "string") return connStr;
    const { username, password } = this.config;
    if (username && !/(?:^|;)\s*UID\s*=/i.test(connStr)) connStr += `;UID=${username}`;
    if (password && !/(?:^|;)\s*PWD\s*=/i.test(connStr)) connStr += `;PWD=${password}`;
    return connStr;
  }

  /**
   * The address for a diagnostic message. ODBC hides it inside an opaque
   * driver keyword string, so this reads the standard keywords and falls back to
   * the data-source name - it is never used to connect, only to say which target
   * hung.
   */
  private describeTarget(): { host: string; port: number | string } {
    const connectionString = this.getConnectionString();
    const host = /(?:^|;)\s*(?:SERVER|SERVERNAME|HOST)\s*=\s*([^;]+)/i.exec(connectionString)?.[1]?.trim()
      ?? /(?:^|;)\s*DSN\s*=\s*([^;]+)/i.exec(connectionString)?.[1]?.trim()
      ?? "the ODBC data source";
    const port = /(?:^|;)\s*PORT\s*=\s*(\d+)/i.exec(connectionString)?.[1] ?? "unspecified";
    return { host, port };
  }

  /** Connect to the ODBC data source. Must be called before using the adapter. */
  async connect(): Promise<void> {
    const odbc = requireOdbc();
    const connStr = this.effectiveConnectionString();
    // odbc package may expose connect as default export or named export
    const connectFn = odbc.connect ?? odbc.default?.connect;
    if (!connectFn) {
      throw new Error("odbc module does not export a connect() function. Check your odbc package version.");
    }
    // Outer bound only: the connection string is the driver's, and injecting a
    // CONNECTIONTIMEOUT keyword into a string the operator wrote would be this
    // adapter editing configuration it does not own. The bound frees the CALLER;
    // the native driver thread it is waiting on cannot be cancelled from JS.
    const { host, port } = this.describeTarget();
    this.connection = await withConnectTimeout(
      () => connectFn(connStr),
      connectTimeoutMillis(),
      host,
      port,
      // Answered after we gave up: close it so the handle does not outlive the boot.
      (arrived: any) => { try { void arrived?.close?.(); } catch { /* already gone */ } },
    );
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

  executeMany(sql: string, paramsList: unknown[][]): { totalAffected: number; lastId?: number | bigint } {
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

  getTables(): string[] {
    throw new Error("Use tablesAsync() for ODBC — async adapter requires async methods.");
  }

  getColumns(table: string): ColumnInfo[] {
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
    if (result && typeof result === "object" && "lastId" in result) {
      this._lastInsertId = (result as any).lastId;
    }
    return result;
  }

  /** Execute a statement with multiple parameter sets inside a single transaction. */
  async executeManyAsync(sql: string, paramsList: unknown[][]): Promise<{ totalAffected: number; lastId?: number | bigint }> {
    this.ensureConnected();
    let totalAffected = 0;

    // Owns-guard (mirrors pg/mysql/mssql + the Python master): only manage the
    // transaction when NOT already inside an explicit one. Without it, nested in
    // a caller's transaction this method's commit() committed the OUTER
    // transaction early.
    const owns = !this._inTransaction;
    if (owns) await this.startTransactionAsync();
    try {
      for (const params of paramsList) {
        const result = await this.connection.query(sql, params);
        totalAffected += this.affectedCount(result);
      }
      if (owns) await this.commitAsync();
    } catch (e) {
      if (owns) await this.rollbackAsync();
      throw e;
    }

    return { totalAffected };
  }

  /** The real affected-row count from an odbc result, when the driver reports it. */
  private affectedCount(result: any): number {
    const n = result?.count;
    return typeof n === "number" && n >= 0 ? n : 1;
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
    // See SQLTranslator.appendLimit: the old inline check was a substring search,
    // so a LIMIT in a string literal or a trailing comment silently dropped the
    // row cap and returned every row.
    const effectiveSql = SQLTranslator.appendLimit(sql, limit, skip);
    return this.queryAsync<T>(effectiveSql, params);
  }

  /** Run a SELECT and return the first row or null. */
  async fetchOneAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    const rows = await this.queryAsync<T>(sql, params);
    return rows[0] ?? null;
  }

  /** Insert a single row, or a list of rows as a batch. */
  async insertAsync(table: string, data: Record<string, unknown> | Record<string, unknown>[]): Promise<DatabaseResult> {
    this.ensureConnected();

    // A list of rows is a batch: ONE parameterised statement run per row through
    // executeManyAsync (owns-guarded, one transaction), matching pg/mysql and the
    // Python master. The single-object path used to run Object.keys() over the
    // array here -> ["0","1",...], a broken INSERT, so batch insert never worked.
    if (Array.isArray(data)) {
      if (data.length === 0) return { success: true, affectedRows: 0 };
      const keys = Object.keys(data[0]);
      const sql = buildInsert(ANSI_DIALECT, table, keys);
      const paramsList = data.map((row) => keys.map((k) => (row as Record<string, unknown>)[k]));
      const { totalAffected } = await this.executeManyAsync(sql, paramsList);
      return { success: true, affectedRows: totalAffected };
    }

    const keys = Object.keys(data);
    const sql = buildInsert(ANSI_DIALECT, table, keys);
    const values = Object.values(data);

    try {
      const result = await this.connection.query(sql, values);
      return { success: true, affectedRows: this.affectedCount(result), lastId: this._lastInsertId ?? undefined };
    } catch (e) {
      return { success: false, affectedRows: 0, error: (e as Error).message };
    }
  }

  /** Update rows in a table matching filter. */
  async updateAsync(
    table: string,
    data: Record<string, unknown>,
    filter: Record<string, unknown> | string,
    params?: unknown[],
  ): Promise<DatabaseResult> {
    this.ensureConnected();
    const setClauses = buildSetClause(ANSI_DIALECT, Object.keys(data));

    let whereSql: string;
    let values: unknown[];
    if (typeof filter === "string") {
      // The string form ("id = ?" + params). Without this branch Object.keys()
      // walked the STRING -> ["0","1",...], building a nonsense WHERE clause -
      // the exact bug the pg/mysql/mssql adapters guard against. params was also
      // dropped entirely (the method never took it), so a parameterised string
      // filter could not bind at all.
      whereSql = filter;
      values = [...Object.values(data), ...(params ?? [])];
    } else {
      whereSql = buildWhereClause(ANSI_DIALECT, Object.keys(filter));
      values = [...Object.values(data), ...Object.values(filter)];
    }
    const sql = `UPDATE ${ANSI_DIALECT.quote(table)} SET ${setClauses} WHERE ${whereSql}`;

    try {
      const result = await this.connection.query(sql, values);
      return { success: true, affectedRows: this.affectedCount(result) };
    } catch (e) {
      return { success: false, affectedRows: 0, error: (e as Error).message };
    }
  }

  /** Delete rows from a table. */
  async deleteAsync(
    table: string,
    filter: Record<string, unknown> | string | Record<string, unknown>[],
    params?: unknown[],
  ): Promise<DatabaseResult> {
    this.ensureConnected();

    if (Array.isArray(filter)) {
      let totalAffected = 0;
      for (const row of filter) {
        const result = await this.deleteAsync(table, row);
        totalAffected += result.affectedRows;
      }
      return { success: true, affectedRows: totalAffected };
    }

    if (typeof filter === "string") {
      // The string form binds its own params (was dropped: query ran with []).
      const sql = filter
        ? `DELETE FROM "${table}" WHERE ${filter}`
        : `DELETE FROM "${table}"`;
      try {
        const result = await this.connection.query(sql, params ?? []);
        return { success: true, affectedRows: this.affectedCount(result) };
      } catch (e) {
        return { success: false, affectedRows: 0, error: (e as Error).message };
      }
    }

    const whereClauses = buildWhereClause(ANSI_DIALECT, Object.keys(filter));
    const sql = `DELETE FROM ${ANSI_DIALECT.quote(table)} WHERE ${whereClauses}`;
    const values = Object.values(filter);

    try {
      const result = await this.connection.query(sql, values);
      return { success: true, affectedRows: this.affectedCount(result) };
    } catch (e) {
      return { success: false, affectedRows: 0, error: (e as Error).message };
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
    // Real PK, from the ODBC catalog (SQLPrimaryKeys) - not the old `false` stub.
    // Feature 4's filterless-write guard reads primaryKey, so without this a
    // PK-keyed update(table, data) on ODBC could not introspect the key.
    const pk = await this.primaryKeyColumns(table);
    return rows.map((r: any) => ({
      name: r.COLUMN_NAME ?? r.column_name,
      type: r.TYPE_NAME ?? r.type_name ?? r.DATA_TYPE ?? "",
      nullable: (r.NULLABLE ?? r.nullable) === 1,
      default: r.COLUMN_DEF ?? r.column_def ?? null,
      primaryKey: pk.has(String(r.COLUMN_NAME ?? r.column_name ?? "").toLowerCase()),
    }));
  }

  /**
   * The table's primary-key columns from the ODBC catalog (SQLPrimaryKeys),
   * lower-cased for case-insensitive matching. Empty on any target that does not
   * report them - the write-guard then requires an explicit filter.
   */
  private async primaryKeyColumns(table: string): Promise<Set<string>> {
    try {
      const rows: any[] = await this.connection.primaryKeys(null, null, table);
      return new Set(rows.map((r: any) => String(r.COLUMN_NAME ?? r.column_name ?? "").toLowerCase()));
    } catch {
      return new Set();
    }
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
      const sqlType = fieldTypeToOdbc(def);
      const parts = [`"${colName}" ${sqlType}`];
      if (def.primaryKey) parts.push("PRIMARY KEY");
      if (def.autoIncrement) parts.push("GENERATED ALWAYS AS IDENTITY"); // ANSI SQL
      if (def.required && !def.primaryKey) parts.push("NOT NULL");
      // A json column carries no DDL DEFAULT (parity with the Python master): an
      // object/array default is applied per instance, not a portable SQL literal.
      if (def.type !== "json" && def.default !== undefined && def.default !== "now") {
        parts.push(`DEFAULT ${sqlDefault(def.default)}`);
      }
      if (def.type !== "json" && def.default === "now") parts.push("DEFAULT CURRENT_TIMESTAMP");
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
    const sqlType = fieldTypeToOdbc(def);
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

function fieldTypeToOdbc(def: FieldDefinition): string {
  switch (def.type) {
    case "integer": return "INTEGER";
    case "number":
    case "numeric": return "DOUBLE PRECISION";
    case "decimal": return `DECIMAL(${def.precision ?? 10},${def.scale ?? 2})`;
    case "boolean": return "SMALLINT";
    case "datetime": return "TIMESTAMP";
    case "text": return "CLOB";
    case "json": return "CLOB";   // store JSON text in a CLOB
    case "string":
    default: return "VARCHAR(255)";
  }
}

function sqlDefault(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}
