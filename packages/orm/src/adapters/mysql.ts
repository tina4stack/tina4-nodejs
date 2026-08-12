/**
 * Tina4 MySQL Adapter — uses the `mysql2` package (optional peer dependency).
 *
 * Install: npm install mysql2
 * URL format: mysql://user:pass@host:port/database
 */
import { MYSQL_DIALECT, buildInsert, buildSetClause, buildWhereClause } from "./sqlDialect.js";
import type { DatabaseAdapter, DatabaseResult, ColumnInfo, FieldDefinition } from "../types.js";
import { SQLTranslator } from "../sqlTranslator.js";
import { connectTarget, connectTimeoutMillis, driverConnectTimeoutMillis, withConnectTimeout } from "../connectTimeout.js";
import { createRequire } from "node:module";

let mysql2: any = null;

function requireMysql2(): any {
  if (mysql2) return mysql2;
  try {
    const req = createRequire(import.meta.url);
    mysql2 = req("mysql2");
    return mysql2;
  } catch {
    throw new Error(
      'MySQL adapter requires the "mysql2" package. Install one of:\n' +
        "    npm install mysql2\n" +
        "    yarn add mysql2\n" +
        "    pnpm add mysql2\n" +
        "    bun add mysql2",
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
  /**
   * Postgres, MySQL and MSSQL all REQUIRE a name for a derived table, so
   * the COUNT probe in Database.countProbe wraps as
   * `FROM (sql) AS _count_query`. SQLite and Firebird leave this unset and
   * get no alias - Firebird rejects `AS` in that position.
   */
  readonly countSubqueryAlias = "_count_query";

  private connection: any = null;
  private _lastInsertId: number | bigint | null = null;
  // True between startTransactionAsync() and commit/rollback. executeManyAsync
  // uses it to decide whether IT owns the batch transaction (mirrors the Python
  // master's owns_txn guard) so it never double-BEGINs inside an explicit one.
  private _inTransaction = false;

  constructor(private config: MysqlConfig | string) {}

  /** Connect to MySQL. Must be called before using the adapter. */
  async connect(): Promise<void> {
    const mod = requireMysql2();

    // mysql2 has its own connectTimeout (10s by default). It is set from the
    // Tina4 budget so ONE variable governs, and omitted when the bound is
    // disabled so the driver keeps exactly the behaviour it had before.
    const budgetMs = connectTimeoutMillis();
    const driverMs = driverConnectTimeoutMillis(budgetMs);
    const timeoutOption = driverMs === null ? {} : { connectTimeout: driverMs };

    const { host, port } = connectTarget(this.config, 3306);
    // createConnection() IS the arming point - mysql2 starts its connectTimeout
    // at the END OF ITS CONSTRUCTOR (base/connection.js), not inside connect() -
    // so it has to sit inside the thunk for the Tina4 clock to start first.
    await withConnectTimeout(
      () => {
        if (typeof this.config === "string") {
          // Parse URL: mysql://user:pass@host:port/database
          const url = new URL(this.config);
          this.connection = mod.createConnection({
            host: url.hostname || "localhost",
            port: url.port ? parseInt(url.port, 10) : 3306,
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
            database: url.pathname.replace(/^\//, ""),
            ...timeoutOption,
          });
        } else {
          this.connection = mod.createConnection({
            host: this.config.host ?? "localhost",
            port: this.config.port ?? 3306,
            user: this.config.user,
            password: this.config.password,
            database: this.config.database,
            ...timeoutOption,
          });
        }

        // Promisify the connection
        return new Promise<void>((resolve, reject) => {
          this.connection.connect((err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
      budgetMs,
      host,
      port,
      // Answered after we gave up: destroy it so the socket does not outlive the boot.
      () => { try { this.connection?.destroy?.(); } catch { /* already gone */ } },
    );
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

  executeMany(sql: string, paramsList: unknown[][]): { totalAffected: number; lastId?: number | bigint } {
    throw new Error("Use executeManyAsync() for MySQL — async adapter requires async methods.");
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
    let lastId: number | bigint | undefined;
    try {
      for (const params of paramsList) {
        const result = await this.executeAsync(sql, params) as any;
        totalAffected += result?.affectedRows ?? 1;
        if (result?.insertId) lastId = result.insertId;
      }
      if (owns) await this.commitAsync();
    } catch (e) {
      if (owns) {
        try { await this.rollbackAsync(); } catch { /* surface the original error */ }
      }
      throw e;
    }
    return { totalAffected, lastId: lastId };
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

  insert(table: string, data: Record<string, unknown> | Record<string, unknown>[]): DatabaseResult {
    throw new Error("Use insertAsync() for MySQL.");
  }

  async insertAsync(table: string, data: Record<string, unknown> | Record<string, unknown>[]): Promise<DatabaseResult> {
    this.ensureConnected();
    // A list of dicts is a batch insert — one parameterised INSERT run per row via
    // executeManyAsync (ONE connection). See PostgresAdapter for the rationale;
    // without this branch a list crashed/mis-built SQL via Object.keys() on the array.
    if (Array.isArray(data)) {
      if (data.length === 0) return { success: true, affectedRows: 0 };
      const keys = Object.keys(data[0]);
      const sql = buildInsert(MYSQL_DIALECT, table, keys);
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
    const sql = buildInsert(MYSQL_DIALECT, table, keys);
    const values = Object.values(data);

    try {
      const result = await this.queryPromise(sql, values);
      this._lastInsertId = result.insertId ?? null;
      return {
        success: true,
        affectedRows: result.affectedRows ?? 1,
        lastId: result.insertId,
      };
    } catch (e) {
      return { success: false, affectedRows: 0, error: (e as Error).message };
    }
  }

  update(table: string, data: Record<string, unknown>, filter: Record<string, unknown>, params?: unknown[]): DatabaseResult {
    throw new Error("Use updateAsync() for MySQL.");
  }

  async updateAsync(table: string, data: Record<string, unknown>, filter: Record<string, unknown> | string, params?: unknown[]): Promise<DatabaseResult> {
    this.ensureConnected();
    const setClauses = buildSetClause(MYSQL_DIALECT, Object.keys(data));

    // A raw WHERE fragment + params is half the write_path contract's filter
    // form. Without this branch Object.keys("id = ?") yields the STRING INDICES
    // ["0","1",...], producing `WHERE \`0\` = ? AND \`1\` = ?` — MySQL then
    // reports an unknown column '0'. MySQL already uses `?`, so the fragment
    // needs no placeholder rewriting.
    if (typeof filter === "string") {
      const where = filter ? ` WHERE ${filter}` : "";
      const sql = `UPDATE ${MYSQL_DIALECT.quote(table)} SET ${setClauses}${where}`;
      const values = [...Object.values(data), ...(params ?? [])];
      try {
        const result = await this.queryPromise(sql, values);
        return { success: true, affectedRows: result.affectedRows ?? 0 };
      } catch (e) {
        return { success: false, affectedRows: 0, error: (e as Error).message };
      }
    }

    const whereClauses = buildWhereClause(MYSQL_DIALECT, Object.keys(filter));
    const sql = `UPDATE ${MYSQL_DIALECT.quote(table)} SET ${setClauses} WHERE ${whereClauses}`;
    const values = [...Object.values(data), ...Object.values(filter)];

    try {
      const result = await this.queryPromise(sql, values);
      return { success: true, affectedRows: result.affectedRows ?? 0 };
    } catch (e) {
      return { success: false, affectedRows: 0, error: (e as Error).message };
    }
  }

  delete(table: string, filter: Record<string, unknown>, params?: unknown[]): DatabaseResult {
    throw new Error("Use deleteAsync() for MySQL.");
  }

  async deleteAsync(table: string, filter: Record<string, unknown> | string, params?: unknown[]): Promise<DatabaseResult> {
    this.ensureConnected();

    // See updateAsync: truncate() calls this with "1 = 1", which became
    // `WHERE \`0\` = ? AND \`1\` = ? ...` — db.truncate() was broken outright.
    if (typeof filter === "string") {
      const sql = filter
        ? `DELETE FROM \`${table}\` WHERE ${filter}`
        : `DELETE FROM \`${table}\``;
      try {
        const result = await this.queryPromise(sql, params ?? []);
        return { success: true, affectedRows: result.affectedRows ?? 0 };
      } catch (e) {
        return { success: false, affectedRows: 0, error: (e as Error).message };
      }
    }

    const whereClauses = buildWhereClause(MYSQL_DIALECT, Object.keys(filter));
    const sql = `DELETE FROM ${MYSQL_DIALECT.quote(table)} WHERE ${whereClauses}`;
    const values = Object.values(filter);

    try {
      const result = await this.queryPromise(sql, values);
      return { success: true, affectedRows: result.affectedRows ?? 0 };
    } catch (e) {
      return { success: false, affectedRows: 0, error: (e as Error).message };
    }
  }

  startTransaction(): void {
    throw new Error("Use startTransactionAsync() for MySQL.");
  }

  async startTransactionAsync(): Promise<void> {
    await this.executeAsync("START TRANSACTION");
    this._inTransaction = true;
  }

  commit(): void {
    throw new Error("Use commitAsync() for MySQL.");
  }

  async commitAsync(): Promise<void> {
    await this.executeAsync("COMMIT");
    this._inTransaction = false;
  }

  rollback(): void {
    throw new Error("Use rollbackAsync() for MySQL.");
  }

  async rollbackAsync(): Promise<void> {
    await this.executeAsync("ROLLBACK");
    this._inTransaction = false;
  }

  getTables(): string[] {
    throw new Error("Use tablesAsync() for MySQL.");
  }

  async tablesAsync(): Promise<string[]> {
    const rows = await this.queryAsync<Record<string, string>>("SHOW TABLES");
    return rows.map((r) => Object.values(r)[0]);
  }

  getColumns(table: string): ColumnInfo[] {
    throw new Error("Use columnsAsync() for MySQL.");
  }

  async columnsAsync(table: string): Promise<ColumnInfo[]> {
    // v3.13.14 (#48): a qualified name ("db.table") must back-quote each part
    // separately, otherwise the dot is read as part of one identifier.
    // MYSQL-DESCRIBE-UNPARAM: DESCRIBE takes an IDENTIFIER, not a bind parameter,
    // so each part is STRICT-quoted with embedded backticks ESCAPED (doubled) -
    // a crafted/odd name becomes ONE escaped identifier (a clean "unknown table",
    // never runnable SQL) instead of a backtick in the name closing the quote.
    const [schema, tbl] = SQLTranslator.splitSchema(table);
    const q = (part: string): string => "`" + String(part).replace(/`/g, "``") + "`";
    const target = schema ? `${q(schema)}.${q(tbl)}` : q(tbl);
    const rows = await this.queryAsync<{
      Field: string;
      Type: string;
      Null: string;
      Default: string | null;
      Key: string;
    }>(`DESCRIBE ${target}`);
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
    // v3.13.14 (#48): MySQL's "schema" is the database. A qualified name
    // ("otherdb.table") checks that catalog; a bare name defaults to the
    // connection's current database via DATABASE().
    const [schema, tbl] = SQLTranslator.splitSchema(name);
    const rows = await this.queryAsync<Record<string, unknown>>(
      "SELECT 1 FROM information_schema.tables " +
        "WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?",
      [schema, tbl],
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
      // A json column carries no DDL DEFAULT (parity with the Python master; and
      // MySQL's native JSON type rejects a literal DEFAULT anyway). The instance
      // still gets its object/array default at construction.
      if (def.type !== "json" && def.default !== undefined && def.default !== "now") {
        parts.push(`DEFAULT ${sqlDefault(def.default)}`);
      }
      if (def.type !== "json" && def.default === "now") {
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
    case "decimal":
      return `DECIMAL(${def.precision ?? 10},${def.scale ?? 2})`;
    case "boolean":
      return "TINYINT(1)";
    case "datetime":
      return "DATETIME";
    case "text":
      return "TEXT";
    case "json":
      return "JSON";
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
