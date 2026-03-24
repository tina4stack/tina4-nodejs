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

  constructor(
    records?: Record<string, unknown>[],
    columns?: string[],
    count?: number,
    limit?: number,
    offset?: number,
  ) {
    this.records = records ?? [];
    this.columns =
      columns ?? (this.records.length > 0 ? Object.keys(this.records[0]) : []);
    this.count = count ?? this.records.length;
    this.limit = limit ?? this.records.length;
    this.offset = offset ?? 0;
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

  /** Pagination envelope. */
  toPaginate(): {
    records: Record<string, unknown>[];
    count: number;
    limit: number;
    offset: number;
  } {
    return {
      records: this.records,
      count: this.count,
      limit: this.limit,
      offset: this.offset,
    };
  }

  /** Iterable — for (const row of result) */
  [Symbol.iterator](): Iterator<Record<string, unknown>> {
    return this.records[Symbol.iterator]();
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
}
