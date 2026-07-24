/**
 * Tina4 MSSQL Adapter — uses the `tedious` package (optional peer dependency).
 *
 * Install: npm install tedious
 * URL format: mssql://user:pass@host:port/database
 */
import type { DatabaseAdapter, DatabaseResult, ColumnInfo, FieldDefinition } from "../types.js";
import { SQLTranslator } from "../sqlTranslator.js";
import { createRequire } from "node:module";

let tedious: any = null;

function requireTedious(): any {
  if (tedious) return tedious;
  try {
    const req = createRequire(import.meta.url);
    tedious = req("tedious");
    return tedious;
  } catch {
    throw new Error(
      'MSSQL adapter requires the "tedious" package. Install one of:\n' +
        "    npm install tedious\n" +
        "    yarn add tedious\n" +
        "    pnpm add tedious\n" +
        "    bun add tedious",
    );
  }
}

export interface MssqlConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  connectionString?: string;
  options?: Record<string, unknown>;
}

export class MssqlAdapter implements DatabaseAdapter {
  private connection: any = null;
  private _lastInsertId: number | bigint | null = null;
  // True between startTransactionAsync() and commit/rollback. executeManyAsync
  // uses it to decide whether IT owns the batch transaction (mirrors the Python
  // master's owns_txn guard) so it never double-BEGINs inside an explicit one.
  private _inTransaction = false;

  constructor(private config: MssqlConfig | string) {}

  /** Connect to MSSQL. Must be called before using the adapter. */
  async connect(): Promise<void> {
    const tediousModule = requireTedious();
    const Connection = tediousModule.Connection;

    let tediousConfig: any;

    if (typeof this.config === "string") {
      const parsed = this.parseUrl(this.config);
      tediousConfig = {
        server: parsed.host,
        authentication: {
          type: "default",
          options: {
            userName: parsed.user,
            password: parsed.password,
          },
        },
        options: {
          database: parsed.database,
          port: parsed.port ?? 1433,
          trustServerCertificate: true,
          encrypt: false,
        },
      };
    } else {
      tediousConfig = {
        server: this.config.host ?? "localhost",
        authentication: {
          type: "default",
          options: {
            userName: this.config.user,
            password: this.config.password,
          },
        },
        options: {
          database: this.config.database,
          port: this.config.port ?? 1433,
          trustServerCertificate: true,
          encrypt: false,
          ...this.config.options,
        },
      };
    }

    await new Promise<void>((resolve, reject) => {
      this.connection = new Connection(tediousConfig);
      this.connection.on("connect", (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
      this.connection.connect();
    });
  }

  private parseUrl(url: string): { host: string; port?: number; user?: string; password?: string; database?: string } {
    const match = url.match(/(?:mssql|sqlserver):\/\/(?:([^:]+):([^@]+)@)?([^:/]+)(?::(\d+))?\/(.+)/);
    if (match) {
      return {
        user: match[1],
        password: match[2],
        host: match[3],
        port: match[4] ? parseInt(match[4], 10) : undefined,
        database: match[5],
      };
    }
    return { host: "localhost", database: url };
  }

  private ensureConnected(): void {
    if (!this.connection) {
      throw new Error("MSSQL adapter not connected. Call connect() first.");
    }
  }

  /** Translate SQL for MSSQL dialect. */
  translateSql(sql: string): string {
    let translated = SQLTranslator.limitToTop(sql);
    translated = SQLTranslator.concatPipesToFunc(translated);
    translated = SQLTranslator.ilikeToLike(translated);
    return translated;
  }

  private execSqlPromise(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const tediousModule = requireTedious();
    const Request = tediousModule.Request;
    const TYPES = tediousModule.TYPES;

    return new Promise((resolve, reject) => {
      const rows: Record<string, unknown>[] = [];
      const request = new Request(sql, (err: Error | null, rowCount: number) => {
        if (err) reject(err);
        else resolve({ rows, rowCount });
      });

      // Add parameters
      if (params) {
        params.forEach((p, i) => {
          const paramName = `p${i}`;
          let type = TYPES.NVarChar;
          if (typeof p === "number") type = Number.isInteger(p) ? TYPES.Int : TYPES.Float;
          else if (typeof p === "boolean") type = TYPES.Bit;
          else if (p instanceof Date) type = TYPES.DateTime;
          request.addParameter(paramName, type, p);
        });
      }

      request.on("row", (columns: any[]) => {
        const row: Record<string, unknown> = {};
        columns.forEach((col: any) => {
          row[col.metadata.colName] = col.value;
        });
        rows.push(row);
      });

      this.connection.execSql(request);
    });
  }

  /** Convert ? placeholders to @p0, @p1, ... for tedious. */
  private convertPlaceholders(sql: string): string {
    let count = 0;
    return sql.replace(/\?/g, () => {
      return `@p${count++}`;
    });
  }

  execute(sql: string, params?: unknown[]): unknown {
    throw new Error("Use executeAsync() for MSSQL — async adapter requires async methods.");
  }

  executeMany(sql: string, paramsList: unknown[][]): { totalAffected: number; lastId?: number | bigint } {
    throw new Error("Use executeManyAsync() for MSSQL — async adapter requires async methods.");
  }

  async executeManyAsync(sql: string, paramsList: unknown[][]): Promise<{ totalAffected: number; lastId?: number | bigint }> {
    // Run the whole batch in ONE transaction so it is atomic (all-or-nothing) —
    // a bad row mid-batch rolls back the rows already inserted instead of
    // leaving a partial write. Mirrors the documented "wrapped in a transaction"
    // contract, the SQLite adapter, and the Python master's execute_many. Only
    // own the transaction when not already inside an explicit one (owns guard),
    // so a batch insert nested in a caller's startTransaction() just joins it.
    const owns = !this._inTransaction;
    if (owns) await this.startTransactionAsync();
    let totalAffected = 0;
    try {
      for (const params of paramsList) {
        await this.executeAsync(sql, params);
        totalAffected++;
      }
      if (owns) await this.commitAsync();
    } catch (e) {
      if (owns) {
        try { await this.rollbackAsync(); } catch { /* surface the original error */ }
      }
      throw e;
    }
    return { totalAffected };
  }

  async executeAsync(sql: string, params?: unknown[]): Promise<unknown> {
    this.ensureConnected();
    const translated = this.translateSql(sql);
    const converted = this.convertPlaceholders(translated);
    return this.execSqlPromise(converted, params);
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    throw new Error("Use queryAsync() for MSSQL.");
  }

  async queryAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    this.ensureConnected();
    const translated = this.translateSql(sql);
    const converted = this.convertPlaceholders(translated);
    const result = await this.execSqlPromise(converted, params);
    return result.rows as T[];
  }

  fetch<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): T[] {
    throw new Error("Use fetchAsync() for MSSQL.");
  }

  async fetchAsync<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): Promise<T[]> {
    let effectiveSql = sql;
    if (limit !== undefined) {
      if (skip !== undefined && skip > 0) {
        // MSSQL uses OFFSET...FETCH for pagination (requires ORDER BY)
        if (!/ORDER BY/i.test(effectiveSql)) {
          effectiveSql += " ORDER BY (SELECT NULL)";
        }
        effectiveSql += ` OFFSET ${skip} ROWS FETCH NEXT ${limit} ROWS ONLY`;
      } else {
        // Use TOP for simple limit
        effectiveSql = effectiveSql.replace(/^(SELECT)\b/i, `$1 TOP ${limit}`);
      }
    }
    return this.queryAsync<T>(effectiveSql, params);
  }

  fetchOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    throw new Error("Use fetchOneAsync() for MSSQL.");
  }

  async fetchOneAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    const rows = await this.queryAsync<T>(sql, params);
    return rows[0] ?? null;
  }

  insert(table: string, data: Record<string, unknown> | Record<string, unknown>[]): DatabaseResult {
    throw new Error("Use insertAsync() for MSSQL.");
  }

  async insertAsync(table: string, data: Record<string, unknown> | Record<string, unknown>[]): Promise<DatabaseResult> {
    this.ensureConnected();
    // A list of dicts is a batch insert — one parameterised INSERT run per row via
    // executeManyAsync (ONE connection). The single-row path appends SELECT
    // SCOPE_IDENTITY() to surface the id; the batch path omits it (no per-row id is
    // tracked for a batch — affectedRows == row count is what callers rely on).
    // See PostgresAdapter for the array-crash rationale this branch fixes.
    if (Array.isArray(data)) {
      if (data.length === 0) return { success: true, affectedRows: 0 };
      const keys = Object.keys(data[0]);
      // `?` placeholders — executeManyAsync -> executeAsync runs convertPlaceholders,
      // which rewrites them to @p0, @p1, ... for tedious.
      const placeholders = keys.map(() => "?").join(", ");
      const sql = `INSERT INTO [${table}] ([${keys.join("], [")}]) VALUES (${placeholders})`;
      const paramsList = data.map((row) => keys.map((k) => row[k]));
      try {
        const result = await this.executeManyAsync(sql, paramsList);
        if (result.lastId !== undefined) this._lastInsertId = result.lastId;
        return { success: true, affectedRows: result.totalAffected, lastId: result.lastId };
      } catch (e) {
        return { success: false, affectedRows: 0, error: (e as Error).message };
      }
    }

    const keys = Object.keys(data);
    const placeholders = keys.map((_, i) => `@p${i}`).join(", ");
    const sql = `INSERT INTO [${table}] ([${keys.join("], [")}]) VALUES (${placeholders}); SELECT SCOPE_IDENTITY() AS id`;
    const values = Object.values(data);

    try {
      const result = await this.execSqlPromise(sql, values);
      const id = result.rows[0]?.id as number ?? null;
      if (id !== null) this._lastInsertId = id;
      return {
        success: true,
        // A single-object insert affects exactly one row. Do NOT use
        // result.rowCount here: the statement is "INSERT ...; SELECT
        // SCOPE_IDENTITY()", and tedious sums the row counts of BOTH statements
        // (1 for the INSERT + 1 for the SELECT), which reported affectedRows=2.
        affectedRows: 1,
        lastId: id ?? undefined,
      };
    } catch (e) {
      return { success: false, affectedRows: 0, error: (e as Error).message };
    }
  }

  update(table: string, data: Record<string, unknown>, filter: Record<string, unknown>, params?: unknown[]): DatabaseResult {
    throw new Error("Use updateAsync() for MSSQL.");
  }

  async updateAsync(table: string, data: Record<string, unknown>, filter: Record<string, unknown>): Promise<DatabaseResult> {
    this.ensureConnected();
    const dataKeys = Object.keys(data);
    const filterKeys = Object.keys(filter);
    let paramIndex = 0;

    const setClauses = dataKeys.map((k) => `[${k}] = @p${paramIndex++}`).join(", ");
    const whereClauses = filterKeys.map((k) => `[${k}] = @p${paramIndex++}`).join(" AND ");
    const sql = `UPDATE [${table}] SET ${setClauses} WHERE ${whereClauses}`;
    const values = [...Object.values(data), ...Object.values(filter)];

    try {
      const result = await this.execSqlPromise(sql, values);
      return { success: true, affectedRows: result.rowCount };
    } catch (e) {
      return { success: false, affectedRows: 0, error: (e as Error).message };
    }
  }

  delete(table: string, filter: Record<string, unknown>, params?: unknown[]): DatabaseResult {
    throw new Error("Use deleteAsync() for MSSQL.");
  }

  async deleteAsync(table: string, filter: Record<string, unknown>): Promise<DatabaseResult> {
    this.ensureConnected();
    const filterKeys = Object.keys(filter);
    let paramIndex = 0;
    const whereClauses = filterKeys.map((k) => `[${k}] = @p${paramIndex++}`).join(" AND ");
    const sql = `DELETE FROM [${table}] WHERE ${whereClauses}`;
    const values = Object.values(filter);

    try {
      const result = await this.execSqlPromise(sql, values);
      return { success: true, affectedRows: result.rowCount };
    } catch (e) {
      return { success: false, affectedRows: 0, error: (e as Error).message };
    }
  }

  startTransaction(): void {
    throw new Error("Use startTransactionAsync() for MSSQL.");
  }

  async startTransactionAsync(): Promise<void> {
    // Use tedious's NATIVE transaction API, NOT a raw "BEGIN TRANSACTION" via
    // execSql: every adapter statement runs through sp_executesql (an RPC), and
    // SQL Server forbids changing @@TRANCOUNT inside an sp_executesql call, so a
    // raw BEGIN raised "Transaction count ... mismatching BEGIN and COMMIT".
    // beginTransaction manages the transaction at the TDS protocol level, so the
    // INSERTs inside it commit/rollback atomically.
    await new Promise<void>((resolve, reject) => {
      this.connection.beginTransaction((err: Error | null) => (err ? reject(err) : resolve()));
    });
    this._inTransaction = true;
  }

  commit(): void {
    throw new Error("Use commitAsync() for MSSQL.");
  }

  async commitAsync(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.connection.commitTransaction((err: Error | null) => (err ? reject(err) : resolve()));
    });
    this._inTransaction = false;
  }

  rollback(): void {
    throw new Error("Use rollbackAsync() for MSSQL.");
  }

  async rollbackAsync(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.connection.rollbackTransaction((err: Error | null) => (err ? reject(err) : resolve()));
    });
    this._inTransaction = false;
  }

  tables(): string[] {
    throw new Error("Use tablesAsync() for MSSQL.");
  }

  async tablesAsync(): Promise<string[]> {
    const rows = await this.queryAsync<{ TABLE_NAME: string }>(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'",
    );
    return rows.map((r) => r.TABLE_NAME);
  }

  columns(table: string): ColumnInfo[] {
    throw new Error("Use columnsAsync() for MSSQL.");
  }

  async columnsAsync(table: string): Promise<ColumnInfo[]> {
    // v3.13.14 (#48): honour a schema-qualified name ("dbo.widget"); a bare
    // name matches in any schema (NULL guard skips the schema filter).
    const [schema, tbl] = SQLTranslator.splitSchema(table);
    const rows = await this.queryAsync<{
      COLUMN_NAME: string;
      DATA_TYPE: string;
      IS_NULLABLE: string;
      COLUMN_DEFAULT: string | null;
    }>(
      "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS " +
        "WHERE TABLE_NAME = ? AND (? IS NULL OR TABLE_SCHEMA = ?)",
      [tbl, schema, schema],
    );
    return rows.map((r) => ({
      name: r.COLUMN_NAME,
      type: r.DATA_TYPE,
      nullable: r.IS_NULLABLE === "YES",
      default: r.COLUMN_DEFAULT,
      primaryKey: false,
    }));
  }

  lastInsertId(): number | bigint | null {
    return this._lastInsertId;
  }

  close(): void {
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
  }

  tableExists(name: string): boolean {
    throw new Error("Use tableExistsAsync() for MSSQL.");
  }

  async tableExistsAsync(name: string): Promise<boolean> {
    // v3.13.14 (#48): honour a schema-qualified name ("dbo.widget"); a bare
    // name matches in any schema (NULL guard skips the schema filter).
    const [schema, tbl] = SQLTranslator.splitSchema(name);
    const rows = await this.queryAsync<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES " +
        "WHERE TABLE_NAME = ? AND (? IS NULL OR TABLE_SCHEMA = ?)",
      [tbl, schema, schema],
    );
    return (rows[0]?.cnt ?? 0) > 0;
  }

  createTable(name: string, columns: Record<string, FieldDefinition>): void {
    throw new Error("Use createTableAsync() for MSSQL.");
  }

  async createTableAsync(name: string, columns: Record<string, FieldDefinition>): Promise<void> {
    const colDefs: string[] = [];

    for (const [colName, def] of Object.entries(columns)) {
      const sqlType = fieldTypeToMssql(def);
      const parts = [`[${colName}] ${sqlType}`];

      if (def.primaryKey && !def.autoIncrement) parts.push("PRIMARY KEY");
      if (def.required && !def.primaryKey) parts.push("NOT NULL");
      // A json column carries no DDL DEFAULT (parity with the Python master): an
      // object/array default is applied per instance, not a portable SQL literal.
      if (def.type !== "json" && def.default !== undefined && def.default !== "now") {
        parts.push(`DEFAULT ${sqlDefault(def.default)}`);
      }
      if (def.type !== "json" && def.default === "now") {
        parts.push("DEFAULT GETDATE()");
      }

      colDefs.push(parts.join(" "));
    }

    // MSSQL doesn't have IF NOT EXISTS — use conditional DDL
    const sql = `IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = '${name}') CREATE TABLE [${name}] (${colDefs.join(", ")})`;
    await this.executeAsync(sql);
  }
}

function fieldTypeToMssql(def: FieldDefinition): string {
  if (def.primaryKey && def.autoIncrement) {
    return "INT IDENTITY(1,1) PRIMARY KEY";
  }
  switch (def.type) {
    case "integer":
      return "INT";
    case "number":
    case "numeric":
      return "FLOAT";
    case "boolean":
      return "BIT";
    case "datetime":
      return "DATETIME";
    case "text":
      return "NTEXT";
    case "json":
      return "NVARCHAR(MAX)";   // MSSQL stores JSON text; its JSON functions read NVARCHAR
    case "string":
      return def.maxLength ? `NVARCHAR(${def.maxLength})` : "NVARCHAR(255)";
    default:
      return "NVARCHAR(MAX)";
  }
}

function sqlDefault(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}
