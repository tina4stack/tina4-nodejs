import type { DatabaseAdapter, ColumnInfo } from "./types.js";

/** Column metadata returned by columnInfo(). */
export interface ColumnInfoResult {
  name: string;
  type: string;
  size: number | null;
  decimals: number | null;
  nullable: boolean;
  primary_key: boolean;
}

/**
 * DatabaseResult — wraps fetched rows with convenience methods.
 *
 * Mirrors Python's `DatabaseResult` dataclass from tina4_python.database.adapter.
 * Provides iteration, JSON/CSV export, pagination metadata, and array-like access.
 */
export class DatabaseResult implements Iterable<Record<string, unknown>> {
  readonly records: Record<string, unknown>[];
  readonly columns: string[];
  readonly count: number;
  readonly limit: number;
  readonly offset: number;
  private readonly _adapter?: DatabaseAdapter;
  private readonly _sql?: string;
  private _columnInfoCache?: ColumnInfoResult[];

  // Index signature so `result[0]` type-checks; the Proxy below makes it work.
  [index: number]: Record<string, unknown> | undefined;

  constructor(
    records?: Record<string, unknown>[],
    columns?: string[],
    count?: number,
    limit?: number,
    offset?: number,
    adapter?: DatabaseAdapter,
    sql?: string,
  ) {
    this.records = records ?? [];
    this.columns =
      columns ?? (this.records.length > 0 ? Object.keys(this.records[0]) : []);
    this.count = count ?? this.records.length;
    this.limit = limit ?? this.records.length;
    this.offset = offset ?? 0;
    this._adapter = adapter;
    this._sql = sql;

    // Array-like numeric index access: `result[0]` returns records[0].
    // A Proxy forwards integer-string keys to the backing records array so the
    // documented `const first = result[0]` works, while every method/property
    // on the instance still resolves normally. Mirrors Python's __getitem__ and
    // PHP's ArrayAccess on DatabaseResult.
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^-?\d+$/.test(prop)) {
          const i = Number(prop);
          return target.records[i < 0 ? target.records.length + i : i];
        }
        return Reflect.get(target, prop, receiver);
      },
      has(target, prop) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          return Number(prop) < target.records.length;
        }
        return Reflect.has(target, prop);
      },
    });
  }

  /** JSON string of records. */
  toJson(): string {
    return JSON.stringify(this.records);
  }

  /** CSV with header row. */
  toCsv(): string {
    if (this.columns.length === 0) return "";
    const escape = (val: unknown): string => {
      if (val === null || val === undefined) return "";
      const str = String(val);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    const header = this.columns.map(escape).join(",");
    const rows = this.records.map((row) =>
      this.columns.map((col) => escape(row[col])).join(","),
    );
    return [header, ...rows].join("\n");
  }

  /** Same as records — plain array of row objects. */
  toArray(): Record<string, unknown>[] {
    return this.records;
  }

  /** Pagination envelope — accepts either (page, perPage) or (offset, limit) style.
   *
   * When called with two arguments both >= 0 and the first >= the second
   * (i.e. offset-style), pass `{ offset, limit }` as the first argument.
   * The simplest way is to always use the default (page, perPage) form and
   * let the autoCRUD layer supply offset/limit from the query string.
   *
   * Returns a superset of keys for backwards-compatibility across all clients.
   */
  toPaginate(page = 1, perPage = 10): {
    records: Record<string, unknown>[];
    data: Record<string, unknown>[];
    count: number;
    total: number;
    limit: number;
    offset: number;
    page: number;
    per_page: number;
    perPage: number;
    totalPages: number;
    total_pages: number;
    has_next: boolean;
    has_prev: boolean;
  } {
    const totalPages = Math.max(1, Math.ceil(this.count / perPage));
    const offset = (page - 1) * perPage;
    const sliced = this.records.slice(offset, offset + perPage);
    return {
      records: sliced,
      data: sliced,
      count: this.count,
      total: this.count,
      limit: perPage,
      offset,
      page,
      per_page: perPage,
      perPage,
      totalPages,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    };
  }

  /** Iterable — for (const row of result) */
  [Symbol.iterator](): Iterator<Record<string, unknown>> {
    return this.records[Symbol.iterator]();
  }

  /** Total count — cross-framework parity with Python/Ruby. */
  size(): number {
    return this.count;
  }

  /** Number of records in this page. */
  get length(): number {
    return this.records.length;
  }

  /** Array-like indexed access with negative index support. */
  at(index: number): Record<string, unknown> | undefined {
    if (index < 0) {
      index = this.records.length + index;
    }
    return this.records[index];
  }

  /** JSON.stringify support — serialises as the records array. */
  toJSON(): Record<string, unknown>[] {
    return this.records;
  }

  /**
   * Return column metadata for the query's table.
   *
   * Lazy — only queries the database when explicitly called. Caches the
   * result so subsequent calls return immediately without re-querying.
   */
  columnInfo(): ColumnInfoResult[] {
    if (this._columnInfoCache !== undefined) {
      return this._columnInfoCache;
    }

    const table = this._extractTableFromSql();

    if (this._adapter && table) {
      try {
        this._columnInfoCache = this._queryColumnMetadata(table);
        return this._columnInfoCache;
      } catch {
        // Fall through to fallback
      }
    }

    this._columnInfoCache = this._fallbackColumnInfo();
    return this._columnInfoCache;
  }

  /** Extract table name from a SQL query using simple regex. */
  private _extractTableFromSql(): string | null {
    if (!this._sql) return null;

    let m = this._sql.match(/\bFROM\s+["']?(\w+)["']?/i);
    if (m) return m[1];

    m = this._sql.match(/\bINSERT\s+INTO\s+["']?(\w+)["']?/i);
    if (m) return m[1];

    m = this._sql.match(/\bUPDATE\s+["']?(\w+)["']?/i);
    if (m) return m[1];

    return null;
  }

  /** Query the database adapter for column metadata. */
  private _queryColumnMetadata(table: string): ColumnInfoResult[] {
    if (!this._adapter) return this._fallbackColumnInfo();

    try {
      const rawCols: ColumnInfo[] = this._adapter.getColumns(table);
      return this._normalizeColumns(rawCols);
    } catch {
      return this._fallbackColumnInfo();
    }
  }

  /** Normalize adapter column info to standard format. */
  private _normalizeColumns(rawCols: ColumnInfo[]): ColumnInfoResult[] {
    return rawCols.map((col) => {
      const colType = (col.type ?? "UNKNOWN").toUpperCase();
      const [size, decimals] = this._parseTypeSize(colType);
      return {
        name: col.name,
        type: colType.replace(/\(.*\)/, ""),
        size,
        decimals,
        nullable: col.nullable ?? true,
        primary_key: col.primaryKey ?? false,
      };
    });
  }

  /** Parse size and decimals from a type string like VARCHAR(255) or NUMERIC(10,2). */
  private _parseTypeSize(typeStr: string): [number | null, number | null] {
    const m = typeStr.match(/\((\d+)(?:\s*,\s*(\d+))?\)/);
    if (m) {
      const size = parseInt(m[1], 10);
      const decimals = m[2] ? parseInt(m[2], 10) : null;
      return [size, decimals];
    }
    return [null, null];
  }

  /** Derive basic column info from record keys when no adapter is available. */
  private _fallbackColumnInfo(): ColumnInfoResult[] {
    if (this.columns.length === 0) return [];
    return this.columns.map((name) => ({
      name,
      type: "UNKNOWN",
      size: null,
      decimals: null,
      nullable: true,
      primary_key: false,
    }));
  }
}
