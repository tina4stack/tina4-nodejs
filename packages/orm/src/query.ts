import type { FieldDefinition, QueryOptions } from "./types.js";
import { DEFAULT_ROW_CAP } from "./database.js";
import { quoteIdentifierAnsi } from "./adapters/sqlDialect.js";

export interface ParsedQuery {
  where: string;
  orderBy: string;
  limit: number;
  offset: number;
  params: unknown[];
}

/**
 * Resolve a caller-supplied key to the model's DB column, or null when the key
 * is not a declared field.
 *
 * tina4: ADR-0069 - identifiers that reach SQL come from the model, never the
 * request. The key may be a declared field (property) name or that field's
 * column name; either way the column returned is the model's own, so nothing
 * but a declared column can be emitted. `columnOf` is the caller's existing
 * property->column mapping (BaseModel.getDbColumn / AutoCrud's getDbCol), so
 * the mapping rule lives in one place. Own keys only, so an inherited Object
 * property can never resolve. Used by AutoCrud (filter + sort) and by
 * BaseModel.find(object).
 */
export function resolveFieldColumn(
  fields: Record<string, FieldDefinition>,
  columnOf: (field: string) => string,
  key: string,
): string | null {
  if (Object.hasOwn(fields, key)) return columnOf(key);
  for (const field of Object.keys(fields)) {
    if (columnOf(field) === key) return columnOf(field);
  }
  return null;
}

/** A filter or sort key that does not resolve to a declared model field. */
export class UnknownFieldError extends Error {
  readonly kind: "filter" | "sort";
  readonly field: string;

  constructor(kind: "filter" | "sort", field: string) {
    super(`Unknown ${kind} field '${field}'`);
    this.name = "UnknownFieldError";
    this.kind = kind;
    this.field = field;
  }
}

/** A query parameter whose SHAPE is wrong (a list or map where one value belongs). */
export class InvalidQueryParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQueryParameterError";
  }
}

const filterValueError = (field: string): InvalidQueryParameterError =>
  new InvalidQueryParameterError(`Filter value for '${field}' must be a single value`);

/**
 * Build the list SQL from parsed query options.
 *
 * `quote` renders every table/column name the builder emits - pass the bound
 * adapter's dialect (`(name) => quoteIdentifier(adapter, name)`); the default is
 * the ANSI `"name"`.
 *
 * Every filter key and sort field is passed through `resolveColumn` (see
 * resolveFieldColumn) and only the column it returns is emitted; a key it does
 * not resolve throws UnknownFieldError before any SQL exists. With no
 * resolver, no filter or sort key resolves (ADR-0069).
 */
export function buildQuery(
  tableName: string,
  options: QueryOptions,
  extraConditions?: string[],
  quote: (name: string) => string = quoteIdentifierAnsi,
  resolveColumn: (key: string) => string | null = () => null,
): {
  sql: string; countSql: string; params: unknown[]; limit: number; offset: number; page: number;
  /** The same SELECT without LIMIT/OFFSET, for adapterFetch to page in the engine's own syntax. */
  pageSql: string;
  /** The filter parameters alone (params minus the trailing limit/offset). */
  filterParams: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const column = (kind: "filter" | "sort", key: string): string => {
    const resolved = resolveColumn(key);
    if (resolved === null) throw new UnknownFieldError(kind, key);
    return quote(resolved);
  };

  // Add extra conditions (soft delete, table filter)
  if (extraConditions) {
    conditions.push(...extraConditions);
  }

  // Parse filters
  if (options.filter) {
    for (const [field, value] of Object.entries(options.filter)) {
      const col = column("filter", field);
      if (typeof value === "object" && value !== null) {
        // Operator filters: filter[age][gt]=25
        const ops = value as Record<string, unknown>;
        for (const [op, opVal] of Object.entries(ops)) {
          // Own keys only: an inherited name ("constructor") is not an operator,
          // and an unknown operator is an error, never silently dropped.
          if (!Object.hasOwn(operatorMap, op)) throw filterValueError(field);
          conditions.push(`${col} ${operatorMap[op]} ?`);
          params.push(opVal);
        }
      } else {
        // Exact match: filter[name]=John
        conditions.push(`${col} = ?`);
        params.push(value);
      }
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Sort: comma-separated parts, empty parts skipped, leading "-" = DESC.
  // ORDER BY is built only from resolved columns and the words ASC / DESC.
  let orderClause = "";
  if (options.sort) {
    const parts: string[] = [];
    for (const part of options.sort.split(",")) {
      const trimmed = part.trim();
      if (trimmed === "") continue;
      const descending = trimmed.startsWith("-");
      const col = column("sort", descending ? trimmed.slice(1) : trimmed);
      parts.push(`${col} ${descending ? "DESC" : "ASC"}`);
    }
    if (parts.length > 0) orderClause = `ORDER BY ${parts.join(", ")}`;
  }

  // Pagination — PAGE-DEC-01: clamp page >= 1 BEFORE deriving offset, so
  // offset=(page-1)*limit can never go negative (a page=0/negative request used
  // to hand the driver a negative OFFSET - a hard error on PostgreSQL and a
  // silent-wrong result on SQLite), and cap the per-page size at DEFAULT_ROW_CAP
  // (100 - the same row cap Database.fetch()/BaseModel.all() already share) so a
  // client cannot request the whole table in one query. Returning the clamped
  // limit/offset/page (not just using them locally) lets the caller build the
  // REST envelope from the values the SQL actually used, instead of recomputing
  // the same arithmetic a second time from the raw, unclamped query params.
  const limit = Math.min(options.limit ?? DEFAULT_ROW_CAP, DEFAULT_ROW_CAP);
  const page = Math.max(options.page ?? 1, 1);
  const offset = (page - 1) * limit;

  const pageSql = `SELECT * FROM ${quote(tableName)} ${whereClause} ${orderClause}`.trimEnd();
  const sql = `SELECT * FROM ${quote(tableName)} ${whereClause} ${orderClause} LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) as total FROM ${quote(tableName)} ${whereClause}`;

  return {
    sql,
    countSql,
    params: [...params, limit, offset],
    limit,
    offset,
    page,
    pageSql,
    filterParams: params,
  };
}

export function parseQueryString(query: Record<string, string>): QueryOptions {
  const options: QueryOptions = {};

  // Parse filter params: filter[name]=John or filter[age][gt]=25. ANY key
  // inside the brackets is captured - buildQuery rejects one that is not a
  // declared field rather than it being silently ignored here (ADR-0069).
  // A second bracket must be a known operator; a list (filter[name][]), a map
  // (filter[name][x]) or a nested key is a wrong-shaped value and throws
  // InvalidQueryParameterError. `sort[...]` is a list/map where a single
  // comma-separated string belongs, and throws the same way.
  // A null-prototype map, so a "__proto__" key is stored (and then rejected)
  // instead of silently re-pointing the object's prototype.
  const filter: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith("sort[")) {
      throw new InvalidQueryParameterError("Query parameter 'sort' must be a single comma-separated string");
    }
    if (!key.startsWith("filter[")) continue;
    const filterMatch = key.match(/^filter\[([^\]]*)\](.*)$/s);
    if (!filterMatch) throw new UnknownFieldError("filter", key.slice("filter[".length));
    const [, field, rest] = filterMatch;
    if (rest === "") {
      filter[field] = value;
      continue;
    }
    const operator = rest.match(/^\[([^[\]]*)\]$/)?.[1];
    if (operator === undefined || !Object.hasOwn(operatorMap, operator)) throw filterValueError(field);
    if (!filter[field] || typeof filter[field] !== "object") {
      filter[field] = {};
    }
    (filter[field] as Record<string, string>)[operator] = value;
  }
  if (Object.keys(filter).length > 0) {
    options.filter = filter;
  }

  if (query.sort) options.sort = query.sort;
  if (query.page) options.page = parseInt(query.page, 10);
  if (query.limit) options.limit = parseInt(query.limit, 10);
  // Allow ?offset= as an alternative to ?page= (offset-based pagination)
  if (query.offset !== undefined) {
    const offset = parseInt(query.offset, 10);
    const limit = options.limit ?? 100;
    // Convert offset → page so the rest of the pipeline stays unchanged
    options.page = Math.floor(offset / limit) + 1;
  }

  return options;
}

const operatorMap: Record<string, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  ne: "!=",
  like: "LIKE",
};
