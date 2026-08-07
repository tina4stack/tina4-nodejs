export type FieldType = "string" | "integer" | "number" | "numeric" | "boolean" | "datetime" | "text" | "json" | "foreignKey";

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
  /** For type "foreignKey": the referenced model name (string) */
  references?: string;
  /** For type "foreignKey": override the has-many property name on the referenced model */
  relatedName?: string;
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
}

export interface DatabaseResult {
  success: boolean;
  affectedRows: number;
  // string covers a non-integer primary key (e.g. a PostgreSQL UUID PK returns
  // its id as a string via RETURNING, not a SERIAL integer) — #256.
  lastId?: number | bigint | string;
  error?: string;
}

export interface DatabaseAdapter {
  /** Execute a statement (INSERT, UPDATE, DELETE, DDL). */
  execute(sql: string, params?: unknown[]): unknown;

  /** Execute a single SQL statement with multiple parameter sets (batch). */
  executeMany(sql: string, paramsList: unknown[][]): { totalAffected: number; lastId?: number | bigint };

  /** Query rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];

  /** Fetch rows with optional pagination (limit/skip). */
  fetch<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): T[];

  /** Fetch a single row or null. */
  fetchOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null;

  /** Insert one or more rows into a table, returns result with lastId. */
  insert(table: string, data: Record<string, unknown> | Record<string, unknown>[]): DatabaseResult;

  /** Update rows in a table matching filter (object or string WHERE), returns affected row count. */
  update(table: string, data: Record<string, unknown>, filter: Record<string, unknown> | string, params?: unknown[]): DatabaseResult;

  /** Delete rows from a table matching filter (object, string WHERE, or array of objects). */
  delete(table: string, filter: Record<string, unknown> | string | Record<string, unknown>[], params?: unknown[]): DatabaseResult;

  /** Start a transaction. */
  startTransaction(): void;

  /** Commit the current transaction. */
  commit(): void;

  /** Rollback the current transaction. */
  rollback(): void;

  /** List all tables in the database. */
  getTables(): string[];

  /** List columns with types for a table. */
  getColumns(table: string): ColumnInfo[];

  /** Get the last inserted id (auto-increment integer, or a UUID/string PK). */
  lastInsertId(): number | bigint | string | null;

  /** Close the connection. */
  close(): void;

  /** Check if a table exists. */
  tableExists(name: string): boolean;

  /** Create a table from field definitions. */
  createTable(name: string, columns: Record<string, FieldDefinition>): void;

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
