/**
 * Minimal ambient type surface for the optional `pg` (node-postgres) peer
 * dependency. `@types/pg` is intentionally NOT a dependency (pg is an optional
 * peer loaded lazily via createRequire), so without this declaration the
 * `typeof import("pg")` references in postgres.ts resolve to an *implicit* any
 * (TS7016) and collapse `this.client` to `never`.
 *
 * This declares only the subset of the pg API that the PostgresAdapter uses:
 * the `Client` class (connect/query/end) and the global `types.setTypeParser`
 * registry. It carries no runtime weight — purely a compile-time contract that
 * matches node-postgres' real shape.
 */
declare module "pg" {
  export interface QueryResultRow {
    [column: string]: unknown;
  }

  export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
    rows: R[];
    rowCount: number | null;
    command: string;
    oid: number;
    fields: unknown[];
  }

  export interface ClientConfig {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    connectionString?: string;
  }

  export class Client {
    constructor(config?: ClientConfig | string);
    connect(): Promise<void>;
    query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values?: unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }

  export class Pool {
    constructor(config?: ClientConfig | string);
    connect(): Promise<Client>;
    query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values?: unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }

  export interface TypeParsers {
    setTypeParser(oid: number, parseFn: (value: string) => unknown): void;
  }

  export const types: TypeParsers;
}
