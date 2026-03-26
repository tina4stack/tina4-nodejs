/**
 * QueryBuilder — Fluent SQL query builder for Tina4 Node.js.
 *
 * Usage:
 *   // Standalone
 *   const result = QueryBuilder.from("users", db)
 *     .select("id", "name")
 *     .where("active = ?", [1])
 *     .orderBy("name ASC")
 *     .limit(10)
 *     .get();
 *
 *   // From ORM model
 *   const result = User.query()
 *     .where("age > ?", [18])
 *     .orderBy("name")
 *     .get();
 */

import type { DatabaseAdapter } from "./types.js";
import { getAdapter } from "./database.js";

export class QueryBuilder {
  private table: string;
  private db: DatabaseAdapter | undefined;
  private columns: string[] = ["*"];
  private wheres: [string, string][] = [];
  private params: unknown[] = [];
  private joinClauses: string[] = [];
  private groupByCols: string[] = [];
  private havings: string[] = [];
  private havingParams: unknown[] = [];
  private orderByCols: string[] = [];
  private limitVal: number | undefined;
  private offsetVal: number | undefined;

  /**
   * Private constructor — use static factory methods.
   */
  private constructor(table: string, db?: DatabaseAdapter) {
    this.table = table;
    this.db = db;
  }

  /**
   * Create a QueryBuilder for a table.
   *
   * @param tableName - Table name.
   * @param db - Optional database adapter.
   * @returns A new QueryBuilder instance.
   */
  static from(tableName: string, db?: DatabaseAdapter): QueryBuilder {
    return new QueryBuilder(tableName, db);
  }

  /**
   * Set the columns to select.
   *
   * @param cols - Column names.
   * @returns this for chaining.
   */
  select(...cols: string[]): QueryBuilder {
    if (cols.length > 0) {
      this.columns = cols;
    }
    return this;
  }

  /**
   * Add a WHERE condition (AND).
   *
   * @param condition - SQL condition with ? placeholders.
   * @param params - Parameter values.
   * @returns this for chaining.
   */
  where(condition: string, params: unknown[] = []): QueryBuilder {
    this.wheres.push(["AND", condition]);
    this.params.push(...params);
    return this;
  }

  /**
   * Add a WHERE condition (OR).
   *
   * @param condition - SQL condition with ? placeholders.
   * @param params - Parameter values.
   * @returns this for chaining.
   */
  orWhere(condition: string, params: unknown[] = []): QueryBuilder {
    this.wheres.push(["OR", condition]);
    this.params.push(...params);
    return this;
  }

  /**
   * Add an INNER JOIN.
   *
   * @param table - Table to join.
   * @param onClause - Join condition.
   * @returns this for chaining.
   */
  join(table: string, onClause: string): QueryBuilder {
    this.joinClauses.push(`INNER JOIN ${table} ON ${onClause}`);
    return this;
  }

  /**
   * Add a LEFT JOIN.
   *
   * @param table - Table to join.
   * @param onClause - Join condition.
   * @returns this for chaining.
   */
  leftJoin(table: string, onClause: string): QueryBuilder {
    this.joinClauses.push(`LEFT JOIN ${table} ON ${onClause}`);
    return this;
  }

  /**
   * Add a GROUP BY column.
   *
   * @param column - Column name.
   * @returns this for chaining.
   */
  groupBy(column: string): QueryBuilder {
    this.groupByCols.push(column);
    return this;
  }

  /**
   * Add a HAVING clause.
   *
   * @param expression - HAVING expression with ? placeholders.
   * @param params - Parameter values.
   * @returns this for chaining.
   */
  having(expression: string, params: unknown[] = []): QueryBuilder {
    this.havings.push(expression);
    this.havingParams.push(...params);
    return this;
  }

  /**
   * Add an ORDER BY clause.
   *
   * @param expression - Column and direction (e.g. "name ASC").
   * @returns this for chaining.
   */
  orderBy(expression: string): QueryBuilder {
    this.orderByCols.push(expression);
    return this;
  }

  /**
   * Set LIMIT and optional OFFSET.
   *
   * @param count - Maximum rows to return.
   * @param offset - Number of rows to skip.
   * @returns this for chaining.
   */
  limit(count: number, offset?: number): QueryBuilder {
    this.limitVal = count;
    if (offset !== undefined) {
      this.offsetVal = offset;
    }
    return this;
  }

  /**
   * Build and return the SQL string without executing.
   *
   * @returns The constructed SQL query.
   */
  toSql(): string {
    let sql = `SELECT ${this.columns.join(", ")} FROM ${this.table}`;

    if (this.joinClauses.length > 0) {
      sql += " " + this.joinClauses.join(" ");
    }

    if (this.wheres.length > 0) {
      sql += " WHERE " + this.buildWhere();
    }

    if (this.groupByCols.length > 0) {
      sql += " GROUP BY " + this.groupByCols.join(", ");
    }

    if (this.havings.length > 0) {
      sql += " HAVING " + this.havings.join(" AND ");
    }

    if (this.orderByCols.length > 0) {
      sql += " ORDER BY " + this.orderByCols.join(", ");
    }

    return sql;
  }

  /**
   * Execute the query and return all matching rows.
   *
   * @returns Array of row objects.
   */
  get<T = Record<string, unknown>>(): T[] {
    this.ensureDb();
    const sql = this.toSql();
    const allParams = [...this.params, ...this.havingParams];

    return this.db!.fetch<T>(
      sql,
      allParams.length > 0 ? allParams : undefined,
      this.limitVal,
      this.offsetVal,
    );
  }

  /**
   * Execute the query and return a single row.
   *
   * @returns A single row object, or null.
   */
  first<T = Record<string, unknown>>(): T | null {
    this.ensureDb();
    const sql = this.toSql();
    const allParams = [...this.params, ...this.havingParams];

    return this.db!.fetchOne<T>(
      sql,
      allParams.length > 0 ? allParams : undefined,
    );
  }

  /**
   * Execute the query and return the row count.
   *
   * @returns Number of matching rows.
   */
  count(): number {
    this.ensureDb();

    // Build a count query by replacing columns
    const original = this.columns;
    this.columns = ["COUNT(*) as cnt"];
    const sql = this.toSql();
    this.columns = original;

    const allParams = [...this.params, ...this.havingParams];

    const row = this.db!.fetchOne<Record<string, unknown>>(
      sql,
      allParams.length > 0 ? allParams : undefined,
    );

    if (!row) return 0;

    // Handle case-insensitive column names
    const cnt = row["cnt"] ?? row["CNT"] ?? 0;
    return Number(cnt);
  }

  /**
   * Check whether any matching rows exist.
   *
   * @returns True if at least one row matches.
   */
  exists(): boolean {
    return this.count() > 0;
  }

  /**
   * Build the WHERE clause from accumulated conditions.
   */
  private buildWhere(): string {
    const parts: string[] = [];
    for (let i = 0; i < this.wheres.length; i++) {
      const [connector, condition] = this.wheres[i];
      if (i === 0) {
        parts.push(condition);
      } else {
        parts.push(`${connector} ${condition}`);
      }
    }
    return parts.join(" ");
  }

  /**
   * Ensure a database adapter is available.
   */
  private ensureDb(): void {
    if (!this.db) {
      try {
        this.db = getAdapter();
      } catch {
        throw new Error("QueryBuilder: No database adapter provided.");
      }
    }
  }
}
