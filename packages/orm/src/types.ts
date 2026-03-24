export type FieldType = "string" | "integer" | "number" | "numeric" | "boolean" | "datetime" | "text";

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
}

export interface RelationshipDefinition {
  model: string;
  foreignKey: string;
}

export interface ModelDefinition {
  tableName: string;
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
  rowsAffected: number;
  lastInsertId?: number | bigint;
  error?: string;
}

export interface DatabaseAdapter {
  /** Execute a statement (INSERT, UPDATE, DELETE, DDL). */
  execute(sql: string, params?: unknown[]): unknown;

  /** Execute a single SQL statement with multiple parameter sets (batch). */
  executeMany(sql: string, paramsList: unknown[][]): { totalAffected: number; lastInsertId?: number | bigint };

  /** Query rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];

  /** Fetch rows with optional pagination (limit/skip). */
  fetch<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): T[];

  /** Fetch a single row or null. */
  fetchOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null;

  /** Insert one or more rows into a table, returns result with lastInsertId. */
  insert(table: string, data: Record<string, unknown> | Record<string, unknown>[]): DatabaseResult;

  /** Update rows in a table matching filter, returns affected row count. */
  update(table: string, data: Record<string, unknown>, filter: Record<string, unknown>): DatabaseResult;

  /** Delete rows from a table matching filter (object, string WHERE, or array of objects). */
  delete(table: string, filter: Record<string, unknown> | string | Record<string, unknown>[]): DatabaseResult;

  /** Start a transaction. */
  startTransaction(): void;

  /** Commit the current transaction. */
  commit(): void;

  /** Rollback the current transaction. */
  rollback(): void;

  /** List all tables in the database. */
  tables(): string[];

  /** List columns with types for a table. */
  columns(table: string): ColumnInfo[];

  /** Get the last auto-increment id. */
  lastInsertId(): number | bigint | null;

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
}

export interface PaginatedResult<T = Record<string, unknown>> {
  data: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/**
 * Wraps an array of fetched rows with convenience methods.
 *
 * Mirrors Python's `DatabaseResult` and Ruby's `Tina4::DatabaseResult`.
 */
export class FetchResult<T = Record<string, unknown>> {
  readonly records: T[];
  readonly count: number;
  readonly sql: string;

  constructor(records: T[], sql = "") {
    this.records = records;
    this.count = records.length;
    this.sql = sql;
  }

  /** Paginate the in-memory result set. */
  toPaginate(page = 1, perPage = 20): PaginatedResult<T> {
    const total = this.count;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const offset = (page - 1) * perPage;
    const data = this.records.slice(offset, offset + perPage);
    return {
      data,
      page,
      perPage,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /** Return the first record or null. */
  first(): T | null {
    return this.records[0] ?? null;
  }

  /** Return the last record or null. */
  last(): T | null {
    return this.records[this.records.length - 1] ?? null;
  }

  /** Check if result is empty. */
  isEmpty(): boolean {
    return this.records.length === 0;
  }

  /** Convert to plain array. */
  toArray(): T[] {
    return [...this.records];
  }

  /** Convert to JSON string. */
  toJSON(): string {
    return JSON.stringify(this.records);
  }

  /** Iterate over records. */
  [Symbol.iterator](): Iterator<T> {
    return this.records[Symbol.iterator]();
  }
}

export interface QueryOptions {
  filter?: Record<string, unknown>;
  sort?: string;
  page?: number;
  limit?: number;
}
