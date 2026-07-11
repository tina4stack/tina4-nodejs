/**
 * Tina4 Firebird Adapter — uses the `node-firebird` package (optional peer dependency).
 *
 * Install: npm install node-firebird
 * URL format: firebird://user:pass@host:port/path/to/database.fdb
 */
import type { DatabaseAdapter, DatabaseResult, ColumnInfo, FieldDefinition } from "../types.js";
import { SQLTranslator } from "../sqlTranslation.js";
import { createRequire } from "node:module";

let firebird: any = null;

function requireFirebird(): any {
  if (firebird) return firebird;
  try {
    const req = createRequire(import.meta.url);
    firebird = req("node-firebird");
    return firebird;
  } catch {
    throw new Error(
      'Firebird adapter requires the "node-firebird" package. Install one of:\n' +
        "    npm install node-firebird\n" +
        "    yarn add node-firebird\n" +
        "    pnpm add node-firebird\n" +
        "    bun add node-firebird",
    );
  }
}

// Detects a Windows drive-letter prefix like "C:/" or "C:\". The leading-slash
// variant ("/C:/...") shows up after URL parsing strips one slash off
// "firebird://host:port/C:/...".
const WIN_DRIVE_RE = /^\/?[A-Za-z]:[/\\]/;

/**
 * Turn a URL path component into a Firebird database identifier.
 *
 * Firebird is the awkward one — it needs either an absolute file path on the
 * server, a Windows drive-letter path, or an alias name. The classic URI form
 * uses a double-slash to keep the leading "/" of an absolute path through
 * URL parsing:
 *
 *     firebird://host:port//firebird/data/app.fdb   ->  /firebird/data/app.fdb
 *
 * But that double slash is unintuitive to anyone used to the way
 * postgres / mysql / mssql encode the database name. We accept five
 * equivalent forms and normalise all of them:
 *
 *   - `//abs/path/db.fdb`    -> `/abs/path/db.fdb`   (classic double-slash)
 *   - `/abs/path/db.fdb`     -> `/abs/path/db.fdb`   (single-slash, what most people type)
 *   - `/C:/Data/db.fdb`      -> `C:/Data/db.fdb`     (Windows, leading URL slash dropped)
 *   - `/C%3A/Data/db.fdb`    -> `C:/Data/db.fdb`     (Windows with URL-encoded colon)
 *   - `/employee`            -> `employee`           (alias — single token)
 *
 * Aliases are detected as the leftover case: a single token with no
 * slashes. Anything path-like is kept as a path.
 */
export function normalizeFirebirdDbIdentifier(rawPath: string): string {
  // php #160: a `?charset=` (or any query) tacked onto a connection URL must
  // NOT leak into the Firebird database identifier — a path/alias never
  // legitimately contains `?`. The charset itself is resolved separately by
  // resolveFirebirdCharset(). Strip the query before decoding/normalising.
  const queryIndex = rawPath.indexOf("?");
  if (queryIndex >= 0) rawPath = rawPath.slice(0, queryIndex);
  let decoded = decodeURIComponent(rawPath);

  // Classic double-slash form: //abs/path -> /abs/path
  if (decoded.startsWith("//")) {
    decoded = decoded.slice(1);
  }

  // Windows drive-letter — drop the URL-introduced leading slash.
  // /C:/Data/db.fdb -> C:/Data/db.fdb
  if (WIN_DRIVE_RE.test(decoded)) {
    if (decoded.startsWith("/")) {
      decoded = decoded.slice(1);
    }
    return decoded;
  }

  // Look at the content after stripping the leading slash. If it's a single
  // token with no separators, it's a Firebird alias — return WITHOUT the
  // leading slash (the alias name itself is the identifier).
  const body = decoded.startsWith("/") ? decoded.slice(1) : decoded;
  if (body && !body.includes("/") && !body.includes("\\")) {
    return body;
  }

  // Otherwise it's a file path. If it already has a leading slash, keep it.
  // If it's a relative-looking path (slash-separated but no leading "/")
  // promote it to absolute — Firebird needs absolute paths and we don't know
  // the server's CWD anyway.
  return decoded.startsWith("/") ? decoded : "/" + decoded;
}

/**
 * Resolve the Firebird connection charset (php #160 / parity with the Python
 * master's `_resolve_firebird_charset`).
 *
 * The adapter used to pass NO charset, deferring to the driver's implicit
 * default, which double-encodes UTF-8 bytes stored under a legacy `NONE`
 * database. This resolves the charset from, in precedence order:
 *
 *   1. the connection URL query — `firebird://host:port/path?charset=NONE`
 *   2. an explicit `charset` on the FirebirdConfig object passed to the adapter
 *   3. the `TINA4_DATABASE_CHARSET` environment variable
 *   4. the `UTF8` default
 *
 * Pure config resolution over its inputs (URL string, explicit charset, env) —
 * it opens NO connection, so it is unit-testable without a live server.
 */
export function resolveFirebirdCharset(connectionString: string, explicitCharset?: string): string {
  let urlCharset: string | undefined;
  const queryIndex = (connectionString ?? "").indexOf("?");
  if (queryIndex >= 0) {
    urlCharset = new URLSearchParams(connectionString.slice(queryIndex + 1)).get("charset") ?? undefined;
  }
  return (
    urlCharset ||
    explicitCharset ||
    process.env.TINA4_DATABASE_CHARSET ||
    "UTF8"
  );
}

export interface FirebirdConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  role?: string;
  pageSize?: number;
  /** Connection charset. Overridden by a `?charset=` URL query; see resolveFirebirdCharset. */
  charset?: string;
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
        // php #160: honour ?charset= in the URL and TINA4_DATABASE_CHARSET so a
        // legacy NONE database isn't force-connected under a mismatched charset.
        charset: resolveFirebirdCharset(this.config),
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
        // php #160: explicit config.charset wins over env, else UTF8 default.
        charset: resolveFirebirdCharset("", this.config.charset),
      };
    }

    // Firebird database identifier resolution — two layers:
    //
    // 1. `TINA4_DATABASE_FIREBIRD_PATH` env override wins if set. Useful for
    //    Windows users with raw backslash paths (no URL encoding required)
    //    and for ops setups that keep server URL and DB location in separate
    //    config layers.
    // 2. Otherwise normalise whatever the URL or config supplied — accepts
    //    every sensible variant (single/double slash, drive letter, alias).
    const envOverride = process.env.TINA4_DATABASE_FIREBIRD_PATH;
    if (envOverride && envOverride.length > 0) {
      fbConfig.database = envOverride;
    } else if (typeof fbConfig.database === "string" && fbConfig.database.length > 0) {
      fbConfig.database = normalizeFirebirdDbIdentifier(fbConfig.database);
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
    // firebird://user:pass@host:port/path/to/db.fdb[?charset=...]
    // The path part after the host is normalised by normalizeFirebirdDbIdentifier()
    // in connect() (which also strips any `?charset=` query — see php #160); here
    // we just preserve it (with the leading "/" the regex strips).
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

  executeMany(sql: string, paramsList: unknown[][]): { totalAffected: number; lastInsertId?: number | bigint } {
    throw new Error("Use executeManyAsync() for Firebird — async adapter requires async methods.");
  }

  async executeManyAsync(sql: string, paramsList: unknown[][]): Promise<{ totalAffected: number; lastInsertId?: number | bigint }> {
    let totalAffected = 0;
    for (const params of paramsList) {
      await this.executeAsync(sql, params);
      totalAffected++;
    }
    return { totalAffected };
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
    return (rows as T[]).map(row => this.decodeBlobs(row));
  }

  /** Ensure BLOB columns are readable — node-firebird may return callback-based
   *  blob readers. Convert to Buffer. Regular buffers pass through unchanged. */
  private decodeBlobs<T>(row: T): T {
    // node-firebird returns BLOBs as Buffer by default when using
    // query(sql, params, callback) — already raw bytes.
    return row;
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

  insert(table: string, data: Record<string, unknown> | Record<string, unknown>[]): DatabaseResult {
    throw new Error("Use insertAsync() for Firebird.");
  }

  async insertAsync(table: string, data: Record<string, unknown> | Record<string, unknown>[]): Promise<DatabaseResult> {
    this.ensureConnected();
    // A list of dicts is a batch insert — one parameterised INSERT run per row via
    // executeManyAsync (ONE connection). Firebird has no generic last_insert_id, so
    // the batch reports affectedRows == row count and no lastInsertId (same as the
    // single-row path). See PostgresAdapter for the array-crash rationale.
    if (Array.isArray(data)) {
      if (data.length === 0) return { success: true, rowsAffected: 0 };
      const keys = Object.keys(data[0]);
      const placeholders = keys.map(() => "?").join(", ");
      const sql = `INSERT INTO "${table}" ("${keys.join('", "')}") VALUES (${placeholders})`;
      const paramsList = data.map((row) => keys.map((k) => row[k]));
      try {
        const result = await this.executeManyAsync(sql, paramsList);
        return { success: true, rowsAffected: result.totalAffected, lastInsertId: result.lastInsertId };
      } catch (e) {
        return { success: false, rowsAffected: 0, error: (e as Error).message };
      }
    }

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

  update(table: string, data: Record<string, unknown>, filter: Record<string, unknown>, params?: unknown[]): DatabaseResult {
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

  delete(table: string, filter: Record<string, unknown>, params?: unknown[]): DatabaseResult {
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
    case "json":
      return "BLOB SUB_TYPE TEXT";   // Firebird has no TEXT/JSON type; store JSON in a text BLOB
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
