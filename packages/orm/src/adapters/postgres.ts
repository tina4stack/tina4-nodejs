/**
 * Tina4 PostgreSQL Adapter — uses the `pg` package (optional peer dependency).
 *
 * Install: npm install pg @types/pg
 * URL format: postgresql://user:pass@host:port/database
 */
import type { DatabaseAdapter, DatabaseResult, ColumnInfo, FieldDefinition } from "../types.js";
import { SQLTranslator } from "../sqlTranslation.js";

import { createRequire } from "node:module";

let pg: typeof import("pg") | null = null;

function requirePg(): typeof import("pg") {
  if (pg) return pg;
  try {
    const req = createRequire(import.meta.url);
    pg = req("pg");
    return pg!;
  } catch {
    throw new Error(
      'PostgreSQL adapter requires the "pg" package. Install it with: npm install pg',
    );
  }
}

export interface PostgresConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  connectionString?: string;
}

export class PostgresAdapter implements DatabaseAdapter {
  private client: InstanceType<typeof import("pg").Client> | null = null;
  private _lastInsertId: number | bigint | null = null;

  constructor(private config: PostgresConfig | string) {}

  /** Connect to PostgreSQL. Must be called before using the adapter. */
  async connect(): Promise<void> {
    const pgModule = requirePg();
    const Client = pgModule.Client ?? (pgModule as any).default?.Client;

    if (typeof this.config === "string") {
      this.client = new Client({ connectionString: this.config });
    } else {
      this.client = new Client(this.config);
    }

    await this.client!.connect();
  }

  private ensureConnected(): asserts this is { client: NonNullable<PostgresAdapter["client"]> } {
    if (!this.client) {
      throw new Error("PostgreSQL adapter not connected. Call connect() first.");
    }
  }

  /** Convert ? placeholders to $1, $2, ... for pg. */
  /** Ensure bytea columns are Buffer (already the case with pg). No-op guard. */
  private decodeBlobs<T>(row: T): T {
    // pg npm returns bytea as Buffer — already raw bytes. No conversion needed.
    return row;
  }

  private convertPlaceholders(sql: string): string {
    let count = 0;
    return sql.replace(/\?/g, () => {
      count++;
      return `$${count}`;
    });
  }

  execute(sql: string, params?: unknown[]): unknown {
    this.ensureConnected();
    const convertedSql = this.convertPlaceholders(sql);
    // pg client methods are async — we store a promise-based wrapper
    // Since the interface is sync, we provide executeAsync for real usage
    throw new Error("Use executeAsync() for PostgreSQL — async adapter requires async methods.");
  }

  executeMany(sql: string, paramsList: unknown[][]): { totalAffected: number; lastInsertId?: number | bigint } {
    throw new Error("Use executeManyAsync() for PostgreSQL — async adapter requires async methods.");
  }

  /** Async executeMany for real usage. */
  async executeManyAsync(sql: string, paramsList: unknown[][]): Promise<{ totalAffected: number; lastInsertId?: number | bigint }> {
    let totalAffected = 0;
    let lastId: number | bigint | undefined;
    for (const params of paramsList) {
      const result = await this.executeAsync(sql, params);
      totalAffected++;
      if (result && typeof result === "object" && "lastInsertId" in (result as any)) {
        lastId = (result as any).lastInsertId;
      }
    }
    return { totalAffected, lastInsertId: lastId };
  }

  /** Async execute for real usage. */
  async executeAsync(sql: string, params?: unknown[]): Promise<unknown> {
    this.ensureConnected();
    const convertedSql = this.convertPlaceholders(sql);
    const result = await this.client!.query(convertedSql, params);
    if (result.rows?.[0]?.id !== undefined) {
      this._lastInsertId = result.rows[0].id;
    }
    return result;
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    throw new Error("Use queryAsync() for PostgreSQL — async adapter requires async methods.");
  }

  /** Async query for real usage. */
  async queryAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    this.ensureConnected();
    const convertedSql = this.convertPlaceholders(sql);
    const result = await this.client!.query(convertedSql, params);
    return (result.rows as T[]).map(row => this.decodeBlobs(row));
  }

  fetch<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): T[] {
    throw new Error("Use fetchAsync() for PostgreSQL.");
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
    throw new Error("Use fetchOneAsync() for PostgreSQL.");
  }

  async fetchOneAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    const rows = await this.queryAsync<T>(sql, params);
    return rows[0] ?? null;
  }

  insert(table: string, data: Record<string, unknown>): DatabaseResult {
    throw new Error("Use insertAsync() for PostgreSQL.");
  }

  async insertAsync(table: string, data: Record<string, unknown>): Promise<DatabaseResult> {
    this.ensureConnected();
    const keys = Object.keys(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `INSERT INTO "${table}" ("${keys.join('", "')}") VALUES (${placeholders}) RETURNING *`;
    const values = Object.values(data);

    try {
      const result = await this.client!.query(sql, values);
      const insertedRow = result.rows[0];
      const id = insertedRow?.id ?? null;
      if (id !== null) this._lastInsertId = id;
      return {
        success: true,
        rowsAffected: result.rowCount ?? 1,
        lastInsertId: id,
      };
    } catch (e) {
      return { success: false, rowsAffected: 0, error: (e as Error).message };
    }
  }

  update(table: string, data: Record<string, unknown>, filter: Record<string, unknown>, params?: unknown[]): DatabaseResult {
    throw new Error("Use updateAsync() for PostgreSQL.");
  }

  async updateAsync(table: string, data: Record<string, unknown>, filter: Record<string, unknown>): Promise<DatabaseResult> {
    this.ensureConnected();
    const dataKeys = Object.keys(data);
    const filterKeys = Object.keys(filter);
    let paramIndex = 1;

    const setClauses = dataKeys.map((k) => `"${k}" = $${paramIndex++}`).join(", ");
    const whereClauses = filterKeys.map((k) => `"${k}" = $${paramIndex++}`).join(" AND ");
    const sql = `UPDATE "${table}" SET ${setClauses} WHERE ${whereClauses}`;
    const values = [...Object.values(data), ...Object.values(filter)];

    try {
      const result = await this.client!.query(sql, values);
      return { success: true, rowsAffected: result.rowCount ?? 0 };
    } catch (e) {
      return { success: false, rowsAffected: 0, error: (e as Error).message };
    }
  }

  delete(table: string, filter: Record<string, unknown>, params?: unknown[]): DatabaseResult {
    throw new Error("Use deleteAsync() for PostgreSQL.");
  }

  async deleteAsync(table: string, filter: Record<string, unknown>): Promise<DatabaseResult> {
    this.ensureConnected();
    const filterKeys = Object.keys(filter);
    let paramIndex = 1;
    const whereClauses = filterKeys.map((k) => `"${k}" = $${paramIndex++}`).join(" AND ");
    const sql = `DELETE FROM "${table}" WHERE ${whereClauses}`;
    const values = Object.values(filter);

    try {
      const result = await this.client!.query(sql, values);
      return { success: true, rowsAffected: result.rowCount ?? 0 };
    } catch (e) {
      return { success: false, rowsAffected: 0, error: (e as Error).message };
    }
  }

  startTransaction(): void {
    throw new Error("Use startTransactionAsync() for PostgreSQL.");
  }

  async startTransactionAsync(): Promise<void> {
    await this.executeAsync("BEGIN");
  }

  commit(): void {
    throw new Error("Use commitAsync() for PostgreSQL.");
  }

  async commitAsync(): Promise<void> {
    await this.executeAsync("COMMIT");
  }

  rollback(): void {
    throw new Error("Use rollbackAsync() for PostgreSQL.");
  }

  async rollbackAsync(): Promise<void> {
    await this.executeAsync("ROLLBACK");
  }

  tables(): string[] {
    throw new Error("Use tablesAsync() for PostgreSQL.");
  }

  async tablesAsync(): Promise<string[]> {
    const rows = await this.queryAsync<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    return rows.map((r) => r.tablename);
  }

  columns(table: string): ColumnInfo[] {
    throw new Error("Use columnsAsync() for PostgreSQL.");
  }

  async columnsAsync(table: string): Promise<ColumnInfo[]> {
    const rows = await this.queryAsync<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1",
      [table],
    );
    return rows.map((r) => ({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === "YES",
      default: r.column_default,
      primaryKey: false,
    }));
  }

  lastInsertId(): number | bigint | null {
    return this._lastInsertId;
  }

  close(): void {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }

  tableExists(name: string): boolean {
    throw new Error("Use tableExistsAsync() for PostgreSQL.");
  }

  async tableExistsAsync(name: string): Promise<boolean> {
    const row = await this.fetchOneAsync<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1) AS exists",
      [name],
    );
    return row?.exists ?? false;
  }

  createTable(name: string, columns: Record<string, FieldDefinition>): void {
    throw new Error("Use createTableAsync() for PostgreSQL.");
  }

  async createTableAsync(name: string, columns: Record<string, FieldDefinition>): Promise<void> {
    const colDefs: string[] = [];

    for (const [colName, def] of Object.entries(columns)) {
      const sqlType = fieldTypeToPostgres(def);
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

    const sql = `CREATE TABLE IF NOT EXISTS "${name}" (${colDefs.join(", ")})`;
    await this.executeAsync(sql);
  }

  /** Translate SQL for PostgreSQL dialect. */
  translateSql(sql: string): string {
    // PostgreSQL supports ILIKE natively, standard LIMIT/OFFSET — minimal translation needed
    return sql;
  }
}

function fieldTypeToPostgres(def: FieldDefinition): string {
  if (def.primaryKey && def.autoIncrement) {
    return "SERIAL PRIMARY KEY";
  }
  switch (def.type) {
    case "integer":
      return "INTEGER";
    case "number":
    case "numeric":
      return "DOUBLE PRECISION";
    case "boolean":
      return "BOOLEAN";
    case "datetime":
      return "TIMESTAMP";
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
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}
