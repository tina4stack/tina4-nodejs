export type FieldType = "string" | "integer" | "number" | "numeric" | "decimal" | "boolean" | "datetime" | "text" | "json" | "foreignKey" | "point";

export interface FieldDefinition {
  type: FieldType;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  required?: boolean;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
  /**
   * For type "decimal": the fixed precision/scale of a real DECIMAL(p, s)
   * column. `number`/`numeric` stay a floating type (the documented money
   * guidance); a `decimal` field keeps the declared scale in the COLUMN, so
   * createTable emits DECIMAL(precision, scale) — identical on
   * PostgreSQL/MySQL/MSSQL/Firebird/SQLite. Default 10 / 2 when omitted.
   */
  precision?: number;
  scale?: number;
  /** For type "foreignKey": the referenced model name (string) */
  references?: string;
  /** For type "foreignKey": override the has-many property name on the referenced model */
  relatedName?: string;
  /** For type "point": spatial reference id (default WGS 84 / 4326). */
  srid?: number;
  /** For type "point": create the provider's spatial index (default true). */
  spatialIndex?: boolean;
}

export interface RelationshipDefinition {
  model: string;
  foreignKey: string;
  /**
   * The relationship accessor/include name on the OWNING model. For an
   * FK-auto-wired has-many this is the declaring class name lowercased + "s"
   * (Python master rule) or the `relatedName` override. Used by eager-load
   * include resolution so an `include: ["posts"]` matches the wired relation.
   */
  relatedName?: string;
}

export interface ModelDefinition {
  tableName: string;
  /**
   * The model CLASS name (e.g. `Item` for tableName `items`), carried from
   * `ModelClass.name` at discovery. Swagger keys `components.schemas` by this —
   * the type name a generated client wants — falling back to a singular
   * PascalCase derivation of tableName when a raw definition carries none.
   */
  className?: string;
  fields: Record<string, FieldDefinition>;
  fieldMapping?: Record<string, string>;
  softDelete?: boolean;
  tableFilter?: string;
  hasOne?: RelationshipDefinition[];
  hasMany?: RelationshipDefinition[];
  belongsTo?: RelationshipDefinition[];
  dbName?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable?: boolean;
  default?: unknown;
  primaryKey?: boolean;
  /**
   * ADR-0044 amendment (Feature 5 Decision 7, 2026-08-10): null for a
   * non-key column; for a composite key this is the 1-based DECLARED
   * PRIMARY KEY (...) order, not table-column order.
   */
  primaryKeyPosition?: number | null;
}

export interface DatabaseResult {
  success: boolean;
  affectedRows: number;
  // string covers a non-integer primary key (e.g. a PostgreSQL UUID PK returns
  // its id as a string via RETURNING, not a SERIAL integer) — #256.
  lastId?: number | bigint | string;
  error?: string;
}

/**
 * ADR-0044 (feature 3, plan/v3/fixtures/adapter_contract.json): the exact
 * fourteen adapter capabilities every DatabaseAdapter implementation must
 * provide (DBA-S01). Kept as data so the conformance suite can check it
 * without a second hand-maintained copy of the list.
 */
export const REQUIRED_ADAPTER_CAPABILITIES = [
  "connect", "close", "getDatabaseType",
  "execute", "executeMany", "fetch", "fetchOne",
  "startTransaction", "commit", "rollback", "autocommit",
  "getTables", "getColumns", "tableExists",
] as const;

/**
 * ADR-0044 NOT_REQUIRED_ON_ADAPTER (DBA-S03): engine-neutral composition that
 * the adapter CONTRACT does not require. Node keeps these as REQUIRED
 * TypeScript interface members anyway (unlike Python/PHP/Ruby's stricter
 * runtime reflection) because `database.ts`/`cachedDatabase.ts` call them
 * directly at dozens of sites with no optional-chaining guard, so making them
 * TS-optional ripples into a much larger refactor than this pass covers;
 * this constant records the ADR's INTENT for the conformance suite to check
 * even though the compiler will not enforce their absence.
 */
export const NOT_REQUIRED_ON_ADAPTER = [
  "query", "insert", "update", "delete", "truncate", "fetchAll",
  "createTable", "addColumn", "lastInsertId", "error", "sqlTranslation",
] as const;

export interface DatabaseAdapter {
  /** Connect (ADR-0044 canonical lifecycle name). May be sync or async. */
  connect(): void | Promise<void>;

  /** Return the canonical, credential-free engine name ("sqlite", "postgres", ...). */
  getDatabaseType(): string;

  /** Execute a statement (INSERT, UPDATE, DELETE, DDL). */
  execute(sql: string, params?: unknown[]): unknown;

  /**
   * Execute a single SQL statement with multiple parameter sets as ONE
   * aggregate result (ADR-0044). The shared write shape `DatabaseResult`
   * ({success, affectedRows, lastId?}) is the target; the pre-ADR-0044 async
   * adapters (Postgres/MySQL/MSSQL/Firebird/Mongo) still return their
   * original `{totalAffected, lastId?}` shape internally today — the union
   * covers both while `adapterExecuteMany()` in database.ts normalises
   * whichever shape it receives at the one chokepoint every public batch
   * write flows through.
   */
  executeMany(sql: string, paramsList: unknown[][]): DatabaseResult | { totalAffected: number; lastId?: number | bigint };

  /** Fetch rows with optional pagination (limit/skip). Native list, no envelope. */
  fetch<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): T[];

  /** Fetch a single row or null. No pagination count probe. */
  fetchOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null;

  /** Start a transaction. */
  startTransaction(): void;

  /** Commit the current transaction. */
  commit(): void;

  /** Rollback the current transaction. */
  rollback(): void;

  /**
   * Native boolean, readable and writable. A plain field is the idiomatic JS
   * shape for "readable and writable" — no getter/setter ceremony needed.
   */
  autocommit: boolean;

  /**
   * ADR-0044 / DBA-P02: whether this adapter's deployment can guarantee an
   * atomic multi-row batch write. Every built-in adapter defaults true (see
   * each adapter's field initializer); a deployment that genuinely cannot (a
   * standalone MongoDB without a replica set is the motivating real case)
   * sets this false so executeMany rejects BEFORE the first write.
   */
  supportsAtomicBatch?: boolean;

  /** List all tables in the database. */
  getTables(): string[];

  /** List columns with types for a table. */
  getColumns(table: string): ColumnInfo[];

  /** Close the connection. */
  close(): void;

  /** Check if a table exists. */
  tableExists(name: string): boolean;

  // -- Engine-neutral composition — NOT part of the ADR-0044 CONTRACT, but
  // kept as required TS members for now (see NOT_REQUIRED_ON_ADAPTER above).

  /** Insert one or more rows into a table, returns result with lastId. */
  insert(table: string, data: Record<string, unknown> | Record<string, unknown>[]): DatabaseResult;

  /** Update rows in a table matching filter (object or string WHERE), returns affected row count. */
  update(table: string, data: Record<string, unknown>, filter: Record<string, unknown> | string, params?: unknown[]): DatabaseResult;

  /** Delete rows from a table matching filter (object, string WHERE, or array of objects). */
  delete(table: string, filter: Record<string, unknown> | string | Record<string, unknown>[], params?: unknown[]): DatabaseResult;

  /** Query rows (legacy convenience, superseded by fetch). */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];

  /** Create a table from field definitions (legacy, DDL composition lives above the adapter). */
  createTable(name: string, columns: Record<string, FieldDefinition>): void;

  /** Get the last inserted id (legacy — prefer DatabaseResult.lastId from execute/executeMany). */
  lastInsertId(): number | bigint | string | null;

  /** Get raw column info (legacy, used by migration). */
  getTableColumns?(name: string): Array<{ name: string; type: string }>;

  /** Add a column to an existing table (legacy, used by migration). */
  addColumn?(table: string, colName: string, def: FieldDefinition): void;

  /**
   * Stable identity of the DATABASE this adapter is connected to, as
   * `engine://host:port/database` with NO credentials - set by whoever built
   * the adapter from a URL or config.
   *
   * The query cache folds this into every key. Without it two databases sharing
   * one cache backend cross-serve each other's rows, because identical SQL text
   * across tenants is the common case.
   */
  cacheIdentity?: string;
}

export interface QueryOptions {
  filter?: Record<string, unknown>;
  sort?: string;
  page?: number;
  limit?: number;
}
