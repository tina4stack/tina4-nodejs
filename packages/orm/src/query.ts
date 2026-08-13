import type { QueryOptions } from "./types.js";
import { DEFAULT_ROW_CAP } from "./database.js";

export interface ParsedQuery {
  where: string;
  orderBy: string;
  limit: number;
  offset: number;
  params: unknown[];
}

export function buildQuery(
  tableName: string,
  options: QueryOptions,
  extraConditions?: string[],
): { sql: string; countSql: string; params: unknown[]; limit: number; offset: number; page: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  // Add extra conditions (soft delete, table filter)
  if (extraConditions) {
    conditions.push(...extraConditions);
  }

  // Parse filters
  if (options.filter) {
    for (const [field, value] of Object.entries(options.filter)) {
      if (typeof value === "object" && value !== null) {
        // Operator filters: filter[age][gt]=25
        const ops = value as Record<string, unknown>;
        for (const [op, opVal] of Object.entries(ops)) {
          const sqlOp = operatorMap[op];
          if (sqlOp) {
            conditions.push(`"${field}" ${sqlOp} ?`);
            params.push(opVal);
          }
        }
      } else {
        // Exact match: filter[name]=John
        conditions.push(`"${field}" = ?`);
        params.push(value);
      }
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Sort
  let orderClause = "";
  if (options.sort) {
    const parts = options.sort.split(",").map((s) => {
      const trimmed = s.trim();
      if (trimmed.startsWith("-")) {
        return `"${trimmed.slice(1)}" DESC`;
      }
      return `"${trimmed}" ASC`;
    });
    orderClause = `ORDER BY ${parts.join(", ")}`;
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

  const sql = `SELECT * FROM "${tableName}" ${whereClause} ${orderClause} LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) as total FROM "${tableName}" ${whereClause}`;

  return {
    sql,
    countSql,
    params: [...params, limit, offset],
    limit,
    offset,
    page,
  };
}

export function parseQueryString(query: Record<string, string>): QueryOptions {
  const options: QueryOptions = {};

  // Parse filter params: filter[name]=John or filter[age][gt]=25
  const filter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    const filterMatch = key.match(/^filter\[(\w+)\](?:\[(\w+)\])?$/);
    if (filterMatch) {
      const field = filterMatch[1];
      const operator = filterMatch[2];
      if (operator) {
        if (!filter[field] || typeof filter[field] !== "object") {
          filter[field] = {};
        }
        (filter[field] as Record<string, string>)[operator] = value;
      } else {
        filter[field] = value;
      }
    }
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
