/**
 * Tina4 PostgreSQL Adapter — uses the `pg` package (optional peer dependency).
 *
 * Install: npm install pg @types/pg
 * URL format: postgresql://user:pass@host:port/database
 */
import { ANSI_DIALECT, POSTGRES_DIALECT, buildInsert, buildSetClause, buildWhereClause } from "./sqlDialect.js";
import type { DatabaseAdapter, DatabaseResult, ColumnInfo, FieldDefinition } from "../types.js";
import { SQLTranslator } from "../sqlTranslator.js";
import { connectTarget, connectTimeoutMillis, driverConnectTimeoutMillis, withConnectTimeout } from "../connectTimeout.js";

import { createRequire } from "node:module";

let pg: typeof import("pg") | null = null;
let typeParsersRegistered = false;

function requirePg(): typeof import("pg") {
  if (pg) return pg;
  try {
    const req = createRequire(import.meta.url);
    pg = req("pg");
    registerTypeParsers(pg!);
    return pg!;
  } catch {
    throw new Error(
      'PostgreSQL adapter requires the "pg" package. Install one of:\n' +
        "    npm install pg\n" +
        "    yarn add pg\n" +
        "    pnpm add pg\n" +
        "    bun add pg",
    );
  }
}

/**
 * Register global pg type parsers so int8 and numeric/decimal columns decode to
 * JS numbers instead of strings. node-postgres returns int8 (OID 20) and
 * numeric (OID 1700) as strings by default to preserve full precision; Python,
 * Ruby and PHP all return native numerics for aggregates (SUM, AVG, COUNT, …),
 * so this brings Node to cross-framework parity. count() and getNextId() already
 * coerce via Number(), so this is purely additive for them.
 *
 * PRECISION CAVEAT: values beyond Number.MAX_SAFE_INTEGER (2^53 - 1) lose
 * precision when coerced to a JS double. That is the accepted trade-off for
 * parity — Python and Ruby return native numerics (and lose precision the same
 * way for floats) too. Applications that need exact 64-bit/arbitrary-precision
 * values should select the column with an explicit ::text cast.
 *
 * Idempotent — registration runs once per process.
 */
function registerTypeParsers(pgModule: typeof import("pg")): void {
  if (typeParsersRegistered) return;
  const types = pgModule.types ?? (pgModule as any).default?.types;
  if (!types?.setTypeParser) return;
  // OID 20  = int8 (bigint)  → Number  (NULL passes through untouched by pg)
  types.setTypeParser(20, (v: string) => Number(v));
  // OID 1700 = numeric / decimal → parseFloat
  types.setTypeParser(1700, (v: string) => parseFloat(v));
  typeParsersRegistered = true;
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
  /**
   * Postgres, MySQL and MSSQL all REQUIRE a name for a derived table, so
   * the COUNT probe in Database.countProbe wraps as
   * `FROM (sql) AS _count_query`. SQLite and Firebird leave this unset and
   * get no alias - Firebird rejects `AS` in that position.
   */
  readonly countSubqueryAlias = "_count_query";

  private client: InstanceType<typeof import("pg").Client> | null = null;
  // string is included for non-integer primary keys: a UUID PK (the common
  // `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` shape) returns its id as a
  // 36-char string via RETURNING, not a SERIAL integer (#256).
  private _lastInsertId: number | bigint | string | null = null;
  // True between startTransactionAsync() and commit/rollback. executeManyAsync
  // uses it to decide whether IT owns the batch transaction (mirrors the Python
  // master's owns_txn guard) so it never double-BEGINs inside an explicit one.
  private _inTransaction = false;

  constructor(private config: PostgresConfig | string) {}

  /** Connect to PostgreSQL. Must be called before using the adapter. */
  /** ADR-0044 required adapter capability. */
  getDatabaseType(): string {
    return 'postgres';
  }

  /** ADR-0044: readable/writable native boolean. */
  autocommit = true;

  /**
   * ADR-0044 / DBA-P02: every built-in adapter can guarantee an atomic
   * multi-row batch by default. A test-only deployment representing one
   * that cannot sets this false so executeMany rejects BEFORE the first
   * write rather than risking partial durability.
   */
  supportsAtomicBatch = true;

  async connect(): Promise<void> {
    const pgModule = requirePg();
    const Client = pgModule.Client ?? (pgModule as any).default?.Client;

    // pg's own connectionTimeoutMillis defaults to 0 - no timeout at all - so
    // without this a server that accepts and never completes the startup
    // handshake hangs the boot forever. Omitted entirely when the bound is
    // disabled, which restores exactly the old (unbounded) behaviour.
    const budgetMs = connectTimeoutMillis();
    const driverMs = driverConnectTimeoutMillis(budgetMs);
    const timeoutOption = driverMs === null ? {} : { connectionTimeoutMillis: driverMs };

    const { host, port } = connectTarget(this.config, 5432);
    // Everything that touches pg lives inside the thunk so the Tina4 clock
    // starts before pg arms its own timer (client.js `_connect`, cleared only at
    // ReadyForQuery - so the knob covers the whole handshake, not just the TCP).
    await withConnectTimeout(
      () => {
        this.client = typeof this.config === "string"
          ? new Client({ connectionString: this.config, ...timeoutOption })
          : new Client({ ...this.config, ...timeoutOption });
        return this.client!.connect();
      },
      budgetMs,
      host,
      port,
      // Answered after we gave up: end it so the socket does not outlive the boot.
      () => { void Promise.resolve(this.client?.end()).catch(() => { /* already gone */ }); },
    );
  }

  // NOTE: a plain runtime guard, not an `asserts this is ...` predicate. A
  // type-narrowing predicate that re-declares the private `client` member
  // intersects the class with a structural literal and collapses `this` to
  // `never` (TS treats the private brand as unsatisfiable). The non-null
  // `this.client!` assertions at the (already-guarded) call sites carry the
  // narrowing instead, so behaviour is unchanged.
  private ensureConnected(): void {
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

  // `startAt` lets a caller that has already consumed N placeholders (an UPDATE
  // whose SET values are $1..$N) continue the numbering into a raw WHERE
  // fragment instead of restarting at $1.
  private convertPlaceholders(sql: string, startAt = 1): string {
    let count = startAt - 1;
    return sql.replace(/\?/g, () => {
      count++;
      return `$${count}`;
    });
  }

  /**
   * Normalise an `id` column value (typed `unknown` because pg row values are
   * `unknown`) into the shape `_lastInsertId` / `DatabaseResult.lastId`
   * expect. At runtime PG returns numeric PKs as number/bigint (the int8/numeric
   * type parsers above coerce them to Number); a numeric string is coerced to a
   * number so the SERIAL path always returns the integer id.
   *
   * A non-numeric string id — the UUID PK case (`id uuid PRIMARY KEY DEFAULT
   * gen_random_uuid()`) returned via RETURNING — is preserved as-is so the
   * insert surfaces the actual id instead of null (#256). null/undefined/empty
   * still become null.
   */
  private normalizeId(value: unknown): number | bigint | string | null {
    if (typeof value === "number" || typeof value === "bigint") return value;
    if (typeof value === "string" && value.trim() !== "") {
      return Number.isNaN(Number(value)) ? value : Number(value);
    }
    return null;
  }

  execute(sql: string, params?: unknown[]): unknown {
    this.ensureConnected();
    const convertedSql = this.convertPlaceholders(sql);
    // pg client methods are async — we store a promise-based wrapper
    // Since the interface is sync, we provide executeAsync for real usage
    throw new Error("Use executeAsync() for PostgreSQL — async adapter requires async methods.");
  }

  executeMany(sql: string, paramsList: unknown[][]): { totalAffected: number; lastId?: number | bigint } {
    throw new Error("Use executeManyAsync() for PostgreSQL — async adapter requires async methods.");
  }

  /** Async executeMany for real usage. */
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
        const result = await this.executeAsync(sql, params);
        totalAffected++;
        if (result && typeof result === "object" && "lastId" in (result as any)) {
          lastId = (result as any).lastId;
        }
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

  /** Async execute for real usage. */
  async executeAsync(sql: string, params?: unknown[]): Promise<unknown> {
    this.ensureConnected();
    const convertedSql = this.convertPlaceholders(sql);
    const result = await this.client!.query(convertedSql, params);
    if (result.rows?.[0]?.id !== undefined) {
      this._lastInsertId = this.normalizeId(result.rows[0].id);
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

  insert(table: string, data: Record<string, unknown> | Record<string, unknown>[]): DatabaseResult {
    throw new Error("Use insertAsync() for PostgreSQL.");
  }

  async insertAsync(table: string, data: Record<string, unknown> | Record<string, unknown>[]): Promise<DatabaseResult> {
    this.ensureConnected();
    // A list of dicts is a batch insert — build one parameterised INSERT and run
    // it once per row via executeManyAsync (ONE connection, wrapped in a single
    // transaction). Database.insert / the docs advertise `data: object | object[]`;
    // without this branch a list called Object.keys() on the array — `["0","1",…]`
    // — producing garbage SQL (mirrors the Python `'list' has no attribute keys`
    // crash this fix addresses).
    if (Array.isArray(data)) {
      if (data.length === 0) return { success: true, affectedRows: 0 };
      const keys = Object.keys(data[0]);
      // The batch path binds through executeManyAsync, which converts "?" itself.
      const sql = buildInsert(ANSI_DIALECT, table, keys);
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
    const sql = buildInsert(POSTGRES_DIALECT, table, keys, " RETURNING *");
    const values = Object.values(data);

    try {
      const result = await this.client!.query(sql, values);
      const insertedRow = result.rows[0];
      const id = this.normalizeId(insertedRow?.id);
      if (id !== null) this._lastInsertId = id;
      return {
        success: true,
        affectedRows: result.rowCount ?? 1,
        lastId: id ?? undefined,
      };
    } catch (e) {
      return { success: false, affectedRows: 0, error: (e as Error).message };
    }
  }

  update(table: string, data: Record<string, unknown>, filter: Record<string, unknown>, params?: unknown[]): DatabaseResult {
    throw new Error("Use updateAsync() for PostgreSQL.");
  }

  async updateAsync(table: string, data: Record<string, unknown>, filter: Record<string, unknown> | string, params?: unknown[]): Promise<DatabaseResult> {
    this.ensureConnected();
    const dataKeys = Object.keys(data);
    let paramIndex = 1;
    const setClauses = buildSetClause(POSTGRES_DIALECT, dataKeys, paramIndex);
    paramIndex += dataKeys.length;

    // A raw WHERE fragment + params is half the write_path contract's filter
    // form ("a string filter with params works the same as a hash filter").
    // Without this branch Object.keys("id = ?") yields the STRING INDICES
    // ["0","1",...], producing `WHERE "0" = $2 AND "1" = $3` — the engine then
    // reports `column "0" does not exist`. sqlite/mongodb/odbc already carried
    // this branch; postgres/mysql/mssql/firebird did not.
    if (typeof filter === "string") {
      const where = filter ? ` WHERE ${this.convertPlaceholders(filter, paramIndex)}` : "";
      const sql = `UPDATE ${POSTGRES_DIALECT.quote(table)} SET ${setClauses}${where}`;
      const values = [...Object.values(data), ...(params ?? [])];
      try {
        const result = await this.client!.query(sql, values);
        return { success: true, affectedRows: result.rowCount ?? 0 };
      } catch (e) {
        return { success: false, affectedRows: 0, error: (e as Error).message };
      }
    }

    const filterKeys = Object.keys(filter);
    const whereClauses = buildWhereClause(POSTGRES_DIALECT, filterKeys, paramIndex);
    paramIndex += filterKeys.length;
    const sql = `UPDATE ${POSTGRES_DIALECT.quote(table)} SET ${setClauses} WHERE ${whereClauses}`;
    const values = [...Object.values(data), ...Object.values(filter)];

    try {
      const result = await this.client!.query(sql, values);
      return { success: true, affectedRows: result.rowCount ?? 0 };
    } catch (e) {
      return { success: false, affectedRows: 0, error: (e as Error).message };
    }
  }

  delete(table: string, filter: Record<string, unknown>, params?: unknown[]): DatabaseResult {
    throw new Error("Use deleteAsync() for PostgreSQL.");
  }

  async deleteAsync(table: string, filter: Record<string, unknown> | string, params?: unknown[]): Promise<DatabaseResult> {
    this.ensureConnected();

    // See updateAsync: a raw WHERE fragment must not be walked as an object.
    // truncate() calls this with "1 = 1", which became `WHERE "0" = $1 AND
    // "1" = $2 ...` and failed with `column "0" does not exist` — db.truncate()
    // was broken outright on PostgreSQL.
    if (typeof filter === "string") {
      const sql = filter
        ? `DELETE FROM "${table}" WHERE ${this.convertPlaceholders(filter)}`
        : `DELETE FROM "${table}"`;
      try {
        const result = await this.client!.query(sql, params ?? []);
        return { success: true, affectedRows: result.rowCount ?? 0 };
      } catch (e) {
        return { success: false, affectedRows: 0, error: (e as Error).message };
      }
    }

    const filterKeys = Object.keys(filter);
    let paramIndex = 1;
    const whereClauses = buildWhereClause(POSTGRES_DIALECT, filterKeys, paramIndex);
    paramIndex += filterKeys.length;
    const sql = `DELETE FROM ${POSTGRES_DIALECT.quote(table)} WHERE ${whereClauses}`;
    const values = Object.values(filter);

    try {
      const result = await this.client!.query(sql, values);
      return { success: true, affectedRows: result.rowCount ?? 0 };
    } catch (e) {
      return { success: false, affectedRows: 0, error: (e as Error).message };
    }
  }

  startTransaction(): void {
    throw new Error("Use startTransactionAsync() for PostgreSQL.");
  }

  async startTransactionAsync(): Promise<void> {
    await this.executeAsync("BEGIN");
    // Mark the connection as inside an explicit transaction so executeManyAsync's
    // owns-guard (owns = !_inTransaction) joins THIS transaction instead of
    // opening its own inner BEGIN/COMMIT (which would commit this outer
    // transaction early and defeat a later rollback). Mirrors the Python master
    // (tina4_python/database/postgres.py start_transaction -> _in_transaction = True).
    this._inTransaction = true;
  }

  commit(): void {
    throw new Error("Use commitAsync() for PostgreSQL.");
  }

  async commitAsync(): Promise<void> {
    await this.executeAsync("COMMIT");
    // Transaction closed — clear the flag so subsequent standalone batches own
    // their own transaction again (parity with Python master commit()).
    this._inTransaction = false;
  }

  rollback(): void {
    throw new Error("Use rollbackAsync() for PostgreSQL.");
  }

  async rollbackAsync(): Promise<void> {
    await this.executeAsync("ROLLBACK");
    // Transaction closed — clear the flag (parity with Python master rollback()).
    this._inTransaction = false;
  }

  getTables(): string[] {
    throw new Error("Use tablesAsync() for PostgreSQL.");
  }

  async tablesAsync(): Promise<string[]> {
    // v3.13.14 (#48): list every user schema; public tables stay bare, others
    // are returned schema-qualified.
    const rows = await this.queryAsync<{ schemaname: string; tablename: string }>(
      "SELECT schemaname, tablename FROM pg_tables " +
        "WHERE schemaname NOT IN ('pg_catalog', 'information_schema') " +
        "ORDER BY schemaname, tablename",
    );
    return rows.map((r) =>
      r.schemaname === "public" ? r.tablename : `${r.schemaname}.${r.tablename}`,
    );
  }

  getColumns(table: string): ColumnInfo[] {
    throw new Error("Use columnsAsync() for PostgreSQL.");
  }

  async columnsAsync(table: string): Promise<ColumnInfo[]> {
    // v3.13.14 (#48): honour a schema-qualified name; default to public.
    const [schema, tbl] = SQLTranslator.splitSchema(table);
    // primaryKey was hardcoded false, so primaryKey(table) introspected NOTHING
    // on PostgreSQL. The filterless-write guard (feature 4) reads it, so
    // update(table, data) keyed on the primary key in `data` threw "update
    // requires a filter or the complete primary key in the data" against every
    // PostgreSQL table. Port the Python master's LEFT JOIN so the cross-engine
    // columns() contract (#48) actually holds here — the subquery yields every
    // column of the PK, so a COMPOSITE key reports true on each of its columns,
    // not just the first.
    const rows = await this.queryAsync<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      is_primary: boolean | string;
    }>(
      `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
              CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_primary
       FROM information_schema.columns c
       LEFT JOIN (
         SELECT ku.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage ku
           ON tc.constraint_name = ku.constraint_name
          AND tc.table_schema = ku.table_schema
         WHERE tc.table_name = $1 AND tc.table_schema = $2
           AND tc.constraint_type = 'PRIMARY KEY'
       ) pk ON c.column_name = pk.column_name
       WHERE c.table_name = $3 AND c.table_schema = $4
       ORDER BY c.ordinal_position`,
      [tbl, schema ?? "public", tbl, schema ?? "public"],
    );
    return rows.map((r) => ({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === "YES",
      default: r.column_default,
      // node-postgres decodes bool to true/false; stay tolerant of the raw
      // "t" text form in case the type parser is bypassed.
      primaryKey: r.is_primary === true || r.is_primary === "t",
    }));
  }

  lastInsertId(): number | bigint | string | null {
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
    // v3.13.14 (#48): to_regclass resolves a (possibly schema-qualified)
    // relation name and search_path like a FROM clause; null if absent.
    const row = await this.fetchOneAsync<{ oid: string | null }>(
      "SELECT to_regclass($1) AS oid",
      [name],
    );
    return (row?.oid ?? null) !== null;
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
      // A json column carries no DDL DEFAULT (parity with the Python master): an
      // object/array default is applied per instance, not a portable SQL literal.
      if (def.type !== "json" && def.default !== undefined && def.default !== "now") {
        parts.push(`DEFAULT ${sqlDefault(def.default)}`);
      }
      if (def.type !== "json" && def.default === "now") {
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
    case "decimal":
      return `DECIMAL(${def.precision ?? 10},${def.scale ?? 2})`;
    case "boolean":
      return "BOOLEAN";
    case "datetime":
      return "TIMESTAMP";
    case "text":
      return "TEXT";
    case "json":
      return "JSONB";
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
