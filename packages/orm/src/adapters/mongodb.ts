/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Tina4 MongoDB Adapter — uses the `mongodb` package (optional peer dependency).
 *
 * Install: npm install mongodb
 * URL format: mongodb://host:port/dbname  or  mongodb+srv://user:pass@host/dbname
 */
import type { DatabaseAdapter, DatabaseResult, ColumnInfo, FieldDefinition } from "../types.js";
import { connectTarget, connectTimeoutMillis, driverConnectTimeoutMillis, withConnectTimeout } from "../connectTimeout.js";

export interface MongoConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  connectionString?: string;
}

/**
 * Parse a simple SQL SELECT/INSERT/UPDATE/DELETE into a MongoDB operation descriptor.
 * Handles the most common patterns that Tina4 ORM generates internally.
 */
interface MongoOperation {
  type: "find" | "insertOne" | "insertMany" | "updateMany" | "deleteMany" | "aggregate" | "listCollections" | "raw";
  collection?: string;
  filter?: Record<string, unknown>;
  document?: Record<string, unknown>;
  documents?: Record<string, unknown>[];
  update?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  limit?: number;
  skip?: number;
  sort?: Record<string, 1 | -1>;
  pipeline?: Record<string, unknown>[];
  /**
   * The write's empty filter is an INTENTIONAL match-all (an explicit 1=1
   * tautology, e.g. truncate()'s WHERE 1 = 1), not a blank/absent WHERE. The
   * executor uses this to let the whole-collection write through the
   * requireWriteFilter guard, which otherwise (correctly) refuses an empty
   * filter as the mass-write footgun.
   */
  matchAll?: boolean;
}

/**
 * The explicit whole-collection tautology: the WHERE clause truncate() issues,
 * "1 = 1". It means MATCH-ALL, so it translates to an empty {} filter and the
 * write reaches deleteMany({}) / updateMany({}) -- emptying or rewriting every
 * document -- exactly as Python/PHP/Ruby do. It is NOT an unparseable WHERE (the
 * fail-closed parse still throws for unsupported SQL) and NOT a blank/absent
 * WHERE (requireWriteFilter still refuses that), so the mass-write guard stays
 * intact.
 */
const MATCH_ALL_WHERE = /^\s*1\s*=\s*1\s*$/;
function isMatchAllWhere(where: string | null | undefined): boolean {
  return where != null && MATCH_ALL_WHERE.test(where);
}

// ── Non-backtracking SQL scanning helpers (ReDoS-safe) ──────────────
// The SQL dispatchers below parse with plain string operations (indexOf /
// slice / single linear scan) instead of regexes with adjacent variable-length
// groups (`\s+(.*?)\s+`), which CodeQL correctly flags as polynomial ReDoS.
// This mirrors the Ruby master's string-based SQL parsing. Behaviour is
// identical to the previous regexes on the ORM-generated SQL these see.

const QUOTE_CHARS = "\"'";

function isSqlWs(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function isWordChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_";
}

/** True when sql[start..end) is empty or all whitespace. */
function onlyWs(sql: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (!isSqlWs(sql[i])) return false;
  return true;
}

/**
 * Index of a whitespace-delimited keyword (matched case-insensitively against
 * `upper`, the upper-cased sql) at or after `from`, or -1. Plain indexOf scan —
 * no backtracking.
 */
function keywordAt(upper: string, keyword: string, from: number): number {
  let at = upper.indexOf(keyword, from);
  while (at >= 0) {
    const end = at + keyword.length;
    const okBefore = at === 0 || isSqlWs(upper[at - 1]);
    const okAfter = end >= upper.length || isSqlWs(upper[end]);
    if (okBefore && okAfter) return at;
    at = upper.indexOf(keyword, at + 1);
  }
  return -1;
}

/** The lowest index among `positions` that is >= 0, else `fallback`. */
function earliest(positions: number[], fallback: number): number {
  let min = fallback;
  for (const p of positions) if (p >= 0 && p < min) min = p;
  return min;
}

/** Read an optionally-quoted identifier (a \w+ run) at/after `from`; [name, end] or null. */
function readIdentifier(sql: string, from: number): [string, number] | null {
  let i = from;
  while (i < sql.length && isSqlWs(sql[i])) i++;
  if (i < sql.length && QUOTE_CHARS.includes(sql[i])) i++;
  const start = i;
  while (i < sql.length && isWordChar(sql[i])) i++;
  if (i === start) return null;
  const name = sql.slice(start, i);
  if (i < sql.length && QUOTE_CHARS.includes(sql[i])) i++;
  return [name, i];
}

/**
 * Index just past `keyword` (whitespace-delimited, case-insensitive) when it is
 * the next token at/after `from` with only whitespace in between, else -1. Folds
 * the recurring "find keyword + require all-whitespace gap" guard.
 */
function keywordGapEnd(upper: string, sql: string, keyword: string, from: number): number {
  const at = keywordAt(upper, keyword, from);
  if (at < 0 || !onlyWs(sql, from, at)) return -1;
  return at + keyword.length;
}

/** Strip one leading and one trailing quote (matches /^["']|["']$/g). */
function stripQuotes(value: string): string {
  let result = value;
  if (result.length > 0 && (result[0] === '"' || result[0] === "'")) result = result.slice(1);
  const last = result.length - 1;
  if (last >= 0 && (result[last] === '"' || result[last] === "'")) result = result.slice(0, last);
  return result;
}

/**
 * Split a WHERE clause on whitespace-delimited AND (case-insensitive), linearly.
 * Each part is trimmed by the caller, so the surrounding whitespace that the old
 * /\s+AND\s+/ delimiter consumed is dropped there too — identical result.
 */
function splitOnAnd(where: string): string[] {
  const parts: string[] = [];
  const lower = where.toLowerCase();
  let segStart = 0;
  let i = 0;
  while (i < where.length) {
    if (lower.startsWith("and", i) && i > 0 && isSqlWs(where[i - 1]) && i + 3 < where.length && isSqlWs(where[i + 3])) {
      parts.push(where.slice(segStart, i));
      i += 3;
      segStart = i;
      continue;
    }
    i++;
  }
  parts.push(where.slice(segStart));
  return parts;
}

/** Convert SQL WHERE clause tokens into a MongoDB filter object. */
function parseWhereClause(where: string, params: unknown[], paramOffset = 0): { filter: Record<string, unknown>; consumed: number } {
  const filter: Record<string, unknown> = {};
  // Simple key = ? / key = 'value' patterns separated by AND (linear split).
  const parts = splitOnAnd(where);
  let paramIndex = paramOffset;

  for (const part of parts) {
    const trimmed = part.trim();

    // The explicit 1=1 tautology contributes no constraint (match-all): skip it
    // rather than mis-parsing "1 = 1" as { "1": 1 } (which matched nothing and
    // made truncate() a silent no-op). NOT an unparseable WHERE -- the
    // fail-closed throw below still fires for genuinely unsupported SQL.
    if (MATCH_ALL_WHERE.test(trimmed)) continue;

    // key = ?
    const eqParam = trimmed.match(/^["']?(\w+)["']?\s*=\s*\?$/i);
    if (eqParam) {
      filter[eqParam[1]] = params[paramIndex++];
      continue;
    }

    // key = 'literal' or key = 123
    const eqLiteral = trimmed.match(/^["']?(\w+)["']?\s*=\s*(?:'([^']*)'|(\d+(?:\.\d+)?))$/i);
    if (eqLiteral) {
      filter[eqLiteral[1]] = eqLiteral[2] !== undefined ? eqLiteral[2] : Number(eqLiteral[3]);
      continue;
    }

    // key != ? or key <> ?
    const neParam = trimmed.match(/^["']?(\w+)["']?\s*(?:!=|<>)\s*\?$/i);
    if (neParam) {
      filter[neParam[1]] = { $ne: params[paramIndex++] };
      continue;
    }

    // key > ?
    const gtParam = trimmed.match(/^["']?(\w+)["']?\s*>\s*\?$/i);
    if (gtParam) {
      filter[gtParam[1]] = { $gt: params[paramIndex++] };
      continue;
    }

    // key >= ?
    const gteParam = trimmed.match(/^["']?(\w+)["']?\s*>=\s*\?$/i);
    if (gteParam) {
      filter[gteParam[1]] = { $gte: params[paramIndex++] };
      continue;
    }

    // key < ?
    const ltParam = trimmed.match(/^["']?(\w+)["']?\s*<\s*\?$/i);
    if (ltParam) {
      filter[ltParam[1]] = { $lt: params[paramIndex++] };
      continue;
    }

    // key <= ?
    const lteParam = trimmed.match(/^["']?(\w+)["']?\s*<=\s*\?$/i);
    if (lteParam) {
      filter[lteParam[1]] = { $lte: params[paramIndex++] };
      continue;
    }

    // key LIKE ?  (translate % wildcards to regex)
    const likeParam = trimmed.match(/^["']?(\w+)["']?\s+(?:I?LIKE)\s+\?$/i);
    if (likeParam) {
      const val = String(params[paramIndex++]);
      const regex = val.replace(/%/g, ".*").replace(/_/g, ".");
      filter[likeParam[1]] = { $regex: regex, $options: "i" };
      continue;
    }

    // key IN (?, ?, ...)  — count the ?s
    const inMatch = trimmed.match(/^["']?(\w+)["']?\s+IN\s*\(([^)]+)\)$/i);
    if (inMatch) {
      const placeholders = (inMatch[2].match(/\?/g) || []).length;
      const values = params.slice(paramIndex, paramIndex + placeholders);
      paramIndex += placeholders;
      filter[inMatch[1]] = { $in: values };
      continue;
    }

    // IS NULL / IS NOT NULL
    const nullMatch = trimmed.match(/^["']?(\w+)["']?\s+IS\s+(NOT\s+)?NULL$/i);
    if (nullMatch) {
      filter[nullMatch[1]] = nullMatch[2] ? { $ne: null } : null;
      continue;
    }

    // Fail closed. An unrecognised condition must NEVER be silently dropped:
    // dropping it leaves an empty (match-all) filter, and on a DELETE/UPDATE
    // that empty filter reaches deleteMany({})/updateMany({}) and wipes or
    // rewrites the WHOLE collection. Throw so the caller sees the unsupported
    // SQL instead of silently losing data.
    throw new Error(
      `Unsupported MongoDB WHERE condition: ${JSON.stringify(trimmed)}. The ` +
        `MongoDB SQL provider fails closed rather than matching every document. ` +
        `Supported: = != <> > >= < <= LIKE, IN, IS [NOT] NULL, AND.`,
    );
  }

  return { filter, consumed: paramIndex - paramOffset };
}

/**
 * Fail closed: a DELETE/UPDATE must carry a real filter.
 *
 * An empty MongoDB filter matches EVERY document, so deleteMany({}) /
 * updateMany({}) would wipe or rewrite the whole collection. Refuse it -- UNLESS
 * the empty filter is an intentional match-all (an explicit 1=1 tautology, the
 * spelling truncate() uses; the caller signals that with the operation's
 * `matchAll` flag or an isMatchAllWhere() check and bypasses this guard). The
 * raw driver is the escape hatch for anything the SQL subset cannot express.
 * Shared by both write paths so the guard cannot drift.
 */
function requireWriteFilter(filter: Record<string, unknown> | undefined, operation: string, table: string | undefined): void {
  if (!filter || Object.keys(filter).length === 0) {
    throw new Error(
      `Refusing to ${operation} every document in ${table}: the statement has no ` +
        `WHERE clause, which would affect the whole collection. Add a WHERE, or use ` +
        `truncate() to clear it explicitly.`,
    );
  }
}

/** Build a MongoDB projection document from a SELECT column list. */
function buildProjection(cols: string): Record<string, unknown> {
  const projection: Record<string, unknown> = {};
  if (!cols || cols.trim() === "*") return projection;
  for (const col of cols.split(",")) {
    const name = stripQuotes(col.trim());
    if (name && name !== "*") projection[name] = 1;
  }
  return projection;
}

/** Remove a trailing whitespace-separated ASC/DESC (case-insensitive). */
function stripTrailingDirection(part: string): string {
  const lower = part.toLowerCase();
  let suffix = 0;
  if (lower.endsWith("asc")) suffix = 3;
  else if (lower.endsWith("desc")) suffix = 4;
  else return part;
  const beforeIdx = part.length - suffix - 1;
  if (beforeIdx < 0 || !isSqlWs(part[beforeIdx])) return part;
  let i = beforeIdx;
  while (i >= 0 && isSqlWs(part[i])) i--;
  return part.slice(0, i + 1);
}

/** Build a MongoDB sort document from an ORDER BY clause. */
function parseOrderBy(orderBy: string): Record<string, 1 | -1> {
  const sort: Record<string, 1 | -1> = {};
  for (const rawPart of orderBy.split(",")) {
    const trimmed = rawPart.trim();
    const desc = trimmed.toLowerCase().endsWith("desc");
    const col = stripQuotes(stripTrailingDirection(trimmed)).trim();
    sort[col] = desc ? -1 : 1;
  }
  return sort;
}

function parseSelect(sql: string, params: unknown[]): MongoOperation | null {
  // Plain string scan — SELECT <cols> FROM <coll> [WHERE ..][ORDER BY ..][LIMIT n][OFFSET n].
  const upper = sql.toUpperCase();
  if (!(upper.startsWith("SELECT") && (sql.length === 6 || isSqlWs(sql[6])))) return null;
  const fromAt = keywordAt(upper, "FROM", 6);
  if (fromAt < 0) return null;
  const cols = sql.slice(6, fromAt).trim();
  const ident = readIdentifier(sql, fromAt + 4);
  if (!ident) return null;
  const [collection, afterColl] = ident;

  const whereAt = keywordAt(upper, "WHERE", afterColl);
  const orderAt = keywordAt(upper, "ORDER BY", afterColl);
  const limitAt = keywordAt(upper, "LIMIT", afterColl);
  const offsetAt = keywordAt(upper, "OFFSET", afterColl);
  const end = sql.length;

  const whereClause = whereAt < 0 ? undefined
    : sql.slice(whereAt + 5, earliest([orderAt, limitAt, offsetAt], end)).trim();
  const orderBy = orderAt < 0 ? undefined
    : sql.slice(orderAt + 8, earliest([limitAt, offsetAt], end)).trim();
  const limitStr = limitAt < 0 ? undefined
    : sql.slice(limitAt + 5, earliest([offsetAt], end)).trim();
  const skipStr = offsetAt < 0 ? undefined : sql.slice(offsetAt + 6).trim();

  const projection = buildProjection(cols);
  const filter = whereClause ? parseWhereClause(whereClause, params).filter : {};
  return {
    type: "find",
    collection,
    filter,
    projection: Object.keys(projection).length > 0 ? projection : undefined,
    limit: limitStr ? parseInt(limitStr, 10) : undefined,
    skip: skipStr ? parseInt(skipStr, 10) : undefined,
    sort: orderBy ? parseOrderBy(orderBy) : undefined,
  };
}

function parseInsert(sql: string, params: unknown[]): MongoOperation | null {
  const match = sql.match(/^INSERT\s+INTO\s+["']?(\w+)["']?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)$/is);
  if (!match) return null;
  const [, collection, colsStr, valsStr] = match;
  const cols = colsStr.split(",").map((column) => column.trim().replace(/^["']|["']$/g, ""));
  const values = valsStr.split(",").map((value) => value.trim());
  const document: Record<string, unknown> = {};
  let paramIndex = 0;
  for (let index = 0; index < cols.length; index++) {
    const value = values[index];
    if (value === "?") document[cols[index]] = params[paramIndex++];
    else if (/^'.*'$/.test(value)) document[cols[index]] = value.slice(1, -1);
    else if (/^-?\d+(\.\d+)?$/.test(value)) document[cols[index]] = Number(value);
    else document[cols[index]] = value;
  }
  return { type: "insertOne", collection, document };
}

function parseSetClause(setClause: string, params: unknown[]): { document: Record<string, unknown>; consumed: number } {
  const document: Record<string, unknown> = {};
  let consumed = 0;
  for (const part of setClause.split(",")) {
    const trimmed = part.trim();
    const parameter = trimmed.match(/^["']?(\w+)["']?\s*=\s*\?$/);
    if (parameter) {
      document[parameter[1]] = params[consumed++];
      continue;
    }
    const literal = trimmed.match(/^["']?(\w+)["']?\s*=\s*(?:'([^']*)'|(-?\d+(?:\.\d+)?))$/);
    if (literal) document[literal[1]] = literal[2] !== undefined ? literal[2] : Number(literal[3]);
  }
  return { document, consumed };
}

function parseUpdate(sql: string, params: unknown[]): MongoOperation | null {
  // Plain string scan — UPDATE <coll> SET <assignments> [WHERE ..].
  const upper = sql.toUpperCase();
  if (!(upper.startsWith("UPDATE") && sql.length > 6 && isSqlWs(sql[6]))) return null;
  const ident = readIdentifier(sql, 6);
  if (!ident) return null;
  const [collection, afterColl] = ident;
  const setAt = keywordAt(upper, "SET", afterColl);
  if (setAt < 0 || !onlyWs(sql, afterColl, setAt)) return null;
  const whereAt = keywordAt(upper, "WHERE", setAt + 3);
  const setClause = sql.slice(setAt + 3, whereAt < 0 ? sql.length : whereAt).trim();
  const whereClause = whereAt < 0 ? undefined : sql.slice(whereAt + 5).trim();
  const set = parseSetClause(setClause, params);
  const matchAll = isMatchAllWhere(whereClause);
  const filter = whereClause ? parseWhereClause(whereClause, params, set.consumed).filter : {};
  return { type: "updateMany", collection, filter, update: { $set: set.document }, matchAll };
}

function parseDelete(sql: string, params: unknown[]): MongoOperation | null {
  // Plain string scan — DELETE FROM <coll> [WHERE ..].
  const upper = sql.toUpperCase();
  if (!upper.startsWith("DELETE")) return null;
  const fromAt = keywordAt(upper, "FROM", 6);
  if (fromAt < 0 || !onlyWs(sql, 6, fromAt)) return null;
  const ident = readIdentifier(sql, fromAt + 4);
  if (!ident) return null;
  const [collection, afterColl] = ident;
  const whereAt = keywordAt(upper, "WHERE", afterColl);
  const whereClause = whereAt < 0 ? undefined : sql.slice(whereAt + 5).trim();
  const matchAll = isMatchAllWhere(whereClause);
  const filter = whereClause ? parseWhereClause(whereClause, params).filter : {};
  return { type: "deleteMany", collection, filter, matchAll };
}

function parseCreate(sql: string): MongoOperation | null {
  const match = sql.match(/^CREATE\s+(?:TABLE|COLLECTION)\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/i);
  return match ? { type: "raw", collection: match[1] } : null;
}

function parseCount(sql: string, params: unknown[]): MongoOperation | null {
  // Plain string scan — SELECT COUNT(*) AS <alias> FROM <coll> [WHERE ..].
  const upper = sql.toUpperCase();
  if (!upper.startsWith("SELECT")) return null;
  const afterCount = keywordGapEnd(upper, sql, "COUNT(*)", 6);
  if (afterCount < 0) return null;
  const afterAs = keywordGapEnd(upper, sql, "AS", afterCount);
  if (afterAs < 0) return null;
  const aliasIdent = readIdentifier(sql, afterAs);
  if (!aliasIdent) return null;
  const [alias, afterAlias] = aliasIdent;
  const afterFrom = keywordGapEnd(upper, sql, "FROM", afterAlias);
  if (afterFrom < 0) return null;
  const coll = readIdentifier(sql, afterFrom);
  if (!coll) return null;
  const [collection, afterColl] = coll;
  const whereAt = keywordAt(upper, "WHERE", afterColl);
  const whereClause = whereAt < 0 ? undefined : sql.slice(whereAt + 5).trim();
  const filter = whereClause ? parseWhereClause(whereClause, params).filter : {};
  return { type: "aggregate", collection, pipeline: [{ $match: filter }, { $count: alias }] };
}

/** Parse a SQL string into a MongoOperation. Returns null if parsing is not supported. */
function parseSql(sql: string, params: unknown[] = []): MongoOperation | null {
  const statement = sql.trim();
  return parseSelect(statement, params)
    ?? parseInsert(statement, params)
    ?? parseUpdate(statement, params)
    ?? parseDelete(statement, params)
    ?? parseCreate(statement)
    ?? parseCount(statement, params);
}

export class MongodbAdapter implements DatabaseAdapter {
  private client: any = null;
  private db: any = null;
  private session: any = null;
  private _lastInsertId: number | bigint | null = null;
  private _inTransaction = false;
  private _connectionString: string;
  private _dbName: string;

  constructor(private config: MongoConfig | string) {
    if (typeof config === "string") {
      this._connectionString = config;
      // Extract database name from the URL path
      try {
        const url = new URL(config);
        this._dbName = url.pathname.replace(/^\//, "") || "tina4";
      } catch {
        this._dbName = "tina4";
      }
    } else {
      const host = config.host ?? "localhost";
      const port = config.port ?? 27017;
      const creds = config.user && config.password
        ? `${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@`
        : "";
      this._connectionString = `mongodb://${creds}${host}:${port}/${config.database ?? "tina4"}`;
      this._dbName = config.database ?? "tina4";
    }
  }

  /** Connect to MongoDB. Must be called before using the adapter. */
  /** ADR-0044 required adapter capability. */
  getDatabaseType(): string {
    return 'mongodb';
  }

  /** ADR-0044: readable/writable native boolean. */
  autocommit = true;

  /**
   * ADR-0044 / DBA-P02: every built-in adapter can guarantee an atomic
   * multi-row batch by default. A test-only deployment representing one
   * that cannot sets this false so executeMany rejects BEFORE the first
   * write rather than risking partial durability.
   */
  supportsAtomicBatch = true;

  async connect(): Promise<void> {
    let MongoClient: any;
    try {
      MongoClient = (await import("mongodb")).MongoClient;
    } catch {
      throw new Error(
        "The 'mongodb' package is required for MongoDB connections. Install one of:\n" +
          "    npm install mongodb\n" +
          "    yarn add mongodb\n" +
          "    pnpm add mongodb\n" +
          "    bun add mongodb",
      );
    }

    // The driver's own budget is 30s (serverSelectionTimeoutMS and
    // connectTimeoutMS both). It is set from the Tina4 budget so ONE variable
    // governs, and omitted when the bound is disabled so the driver keeps its
    // own 30s exactly as before.
    const budgetMs = connectTimeoutMillis();
    const driverMs = driverConnectTimeoutMillis(budgetMs);
    const timeoutOptions = driverMs === null
      ? {}
      : { serverSelectionTimeoutMS: driverMs, connectTimeoutMS: driverMs };

    const { host, port } = connectTarget(this._connectionString, 27017);
    await withConnectTimeout(
      () => {
        this.client = new MongoClient(this._connectionString, timeoutOptions);
        return this.client.connect();
      },
      budgetMs,
      host,
      port,
      // Answered after we gave up: close it so the pool does not outlive the boot.
      () => { void Promise.resolve(this.client?.close()).catch(() => { /* already gone */ }); },
    );
    this.db = this.client.db(this._dbName);
  }

  private ensureConnected(): void {
    if (!this.db) {
      throw new Error("MongoDB adapter not connected. Call connect() first.");
    }
  }

  /** Execute a SQL-like statement translated to a MongoDB operation. */
  execute(sql: string, params?: unknown[]): unknown {
    throw new Error("Use executeAsync() for MongoDB — async adapter requires async methods.");
  }

  async executeAsync(sql: string, params?: unknown[]): Promise<unknown> {
    this.ensureConnected();
    const op = parseSql(sql, params ?? []);

    if (!op || op.type === "raw") {
      // Unsupported SQL — log and skip (DDL, etc.)
      return { acknowledged: true };
    }

    const col = this.db.collection(op.collection!);

    switch (op.type) {
      case "insertOne": {
        const result = await col.insertOne(op.document!, { session: this.session });
        this._lastInsertId = null; // MongoDB uses ObjectId
        return result;
      }
      case "insertMany": {
        const result = await col.insertMany(op.documents!, { session: this.session });
        return result;
      }
      case "updateMany": {
        // matchAll = an explicit 1=1 tautology; its empty filter is an
        // intentional whole-collection write, not the blank-WHERE footgun.
        if (!op.matchAll) requireWriteFilter(op.filter, "UPDATE", op.collection);
        const result = await col.updateMany(op.filter!, op.update!, { session: this.session });
        return result;
      }
      case "deleteMany": {
        if (!op.matchAll) requireWriteFilter(op.filter, "DELETE", op.collection);
        const result = await col.deleteMany(op.filter!, { session: this.session });
        return result;
      }
      case "find": {
        let cursor = col.find(op.filter ?? {}, { session: this.session });
        if (op.projection) cursor = cursor.project(op.projection);
        if (op.sort) cursor = cursor.sort(op.sort);
        if (op.skip) cursor = cursor.skip(op.skip);
        if (op.limit) cursor = cursor.limit(op.limit);
        return cursor.toArray();
      }
      case "aggregate": {
        return col.aggregate(op.pipeline ?? [], { session: this.session }).toArray();
      }
      default:
        return { acknowledged: true };
    }
  }

  executeMany(sql: string, paramsList: unknown[][]): { totalAffected: number; lastId?: number | bigint } {
    throw new Error("Use executeManyAsync() for MongoDB — async adapter requires async methods.");
  }

  async executeManyAsync(sql: string, paramsList: unknown[][]): Promise<{ totalAffected: number; lastId?: number | bigint }> {
    let totalAffected = 0;
    for (const params of paramsList) {
      await this.executeAsync(sql, params);
      totalAffected++;
    }
    return { totalAffected };
  }

  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    throw new Error("Use queryAsync() for MongoDB — async adapter requires async methods.");
  }

  async queryAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    this.ensureConnected();
    const op = parseSql(sql, params ?? []);

    if (!op) return [];

    const col = this.db.collection(op.collection!);

    switch (op.type) {
      case "find": {
        let cursor = col.find(op.filter ?? {}, { session: this.session });
        if (op.projection) cursor = cursor.project(op.projection);
        if (op.sort) cursor = cursor.sort(op.sort);
        if (op.skip) cursor = cursor.skip(op.skip);
        if (op.limit) cursor = cursor.limit(op.limit);
        return cursor.toArray() as Promise<T[]>;
      }
      case "aggregate": {
        return col.aggregate(op.pipeline ?? [], { session: this.session }).toArray() as Promise<T[]>;
      }
      default:
        return [];
    }
  }

  fetch<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): T[] {
    throw new Error("Use fetchAsync() for MongoDB — async adapter requires async methods.");
  }

  async fetchAsync<T = Record<string, unknown>>(sql: string, params?: unknown[], limit?: number, skip?: number): Promise<T[]> {
    this.ensureConnected();
    const op = parseSql(sql, params ?? []);

    if (!op || op.type !== "find") return this.queryAsync<T>(sql, params);

    const col = this.db.collection(op.collection!);
    let cursor = col.find(op.filter ?? {}, { session: this.session });
    if (op.projection) cursor = cursor.project(op.projection);
    if (op.sort) cursor = cursor.sort(op.sort);

    const effectiveSkip = skip ?? op.skip ?? 0;
    const effectiveLimit = limit ?? op.limit;
    if (effectiveSkip > 0) cursor = cursor.skip(effectiveSkip);
    if (effectiveLimit !== undefined) cursor = cursor.limit(effectiveLimit);

    return cursor.toArray() as Promise<T[]>;
  }

  fetchOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | null {
    throw new Error("Use fetchOneAsync() for MongoDB — async adapter requires async methods.");
  }

  async fetchOneAsync<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    const rows = await this.fetchAsync<T>(sql, params, 1);
    return rows[0] ?? null;
  }

  /**
   * Atomic, monotonic, concurrency-safe next id — feature 16. A
   * findOneAndUpdate($inc) on the tina4_sequences collection, keyed by _id (its
   * built-in unique index makes concurrent first-use upserts race-safe: two
   * callers can never create two counters for one table). Seeds from
   * MAX(pkColumn) the FIRST time only ($setOnInsert). Throws on an impossible
   * empty result rather than returning a fixed id that could collide with a row.
   */
  async getNextId(table: string, pkColumn = "id"): Promise<number> {
    this.ensureConnected();
    const sequences = this.db.collection("tina4_sequences");
    const seqName = `${table}.${pkColumn}`;

    const existing = await sequences.findOne({ _id: seqName }, { session: this.session });
    if (existing == null) {
      let seed = 0;
      try {
        const maxDoc = await this.db.collection(table)
          .find({}, { session: this.session })
          .sort({ [pkColumn]: -1 })
          .limit(1)
          .next();
        if (maxDoc && maxDoc[pkColumn] != null) seed = Number(maxDoc[pkColumn]);
      } catch { /* collection may not exist yet — seed 0 */ }
      try {
        await sequences.updateOne(
          { _id: seqName },
          { $setOnInsert: { current_value: seed } },
          { upsert: true, session: this.session },
        );
      } catch { /* race — another caller seeded first; the $inc below still holds */ }
    }

    const res = await sequences.findOneAndUpdate(
      { _id: seqName },
      { $inc: { current_value: 1 } },
      { upsert: true, returnDocument: "after", session: this.session },
    );
    // The mongodb driver returns the doc directly (v5/v6) or wrapped as
    // { value: doc } (v4). Our counter doc has no `value` field, so this is safe.
    const doc = res != null && (res as any).value !== undefined ? (res as any).value : res;
    if (!doc || (doc as any).current_value == null) {
      throw new Error(`getNextId: MongoDB counter '${seqName}' produced no value`);
    }
    return Number((doc as any).current_value);
  }

  insert(table: string, data: Record<string, unknown> | Record<string, unknown>[]): DatabaseResult {
    throw new Error("Use insertAsync() for MongoDB — async adapter requires async methods.");
  }

  async insertAsync(table: string, data: Record<string, unknown> | Record<string, unknown>[]): Promise<DatabaseResult> {
    this.ensureConnected();
    const col = this.db.collection(table);
    try {
      if (Array.isArray(data)) {
        if (data.length === 0) return { success: true, affectedRows: 0 };
        const result = await col.insertMany(data, { session: this.session });
        return { success: true, affectedRows: result.insertedCount };
      }
      const result = await col.insertOne(data, { session: this.session });
      return { success: true, affectedRows: 1, lastId: undefined };
    } catch (e) {
      return { success: false, affectedRows: 0, error: (e as Error).message };
    }
  }

  update(table: string, data: Record<string, unknown>, filter: Record<string, unknown>): DatabaseResult {
    throw new Error("Use updateAsync() for MongoDB — async adapter requires async methods.");
  }

  async updateAsync(table: string, data: Record<string, unknown>, filter: Record<string, unknown>): Promise<DatabaseResult> {
    this.ensureConnected();
    requireWriteFilter(filter, "UPDATE", table);
    const col = this.db.collection(table);
    try {
      const result = await col.updateMany(filter, { $set: data }, { session: this.session });
      return { success: true, affectedRows: result.modifiedCount };
    } catch (e) {
      return { success: false, affectedRows: 0, error: (e as Error).message };
    }
  }

  delete(table: string, filter: Record<string, unknown> | string | Record<string, unknown>[]): DatabaseResult {
    throw new Error("Use deleteAsync() for MongoDB — async adapter requires async methods.");
  }

  async deleteAsync(table: string, filter: Record<string, unknown> | string | Record<string, unknown>[]): Promise<DatabaseResult> {
    this.ensureConnected();
    const col = this.db.collection(table);
    try {
      if (Array.isArray(filter)) {
        let total = 0;
        for (const f of filter) {
          requireWriteFilter(f, "DELETE", table);
          const r = await col.deleteMany(f, { session: this.session });
          total += r.deletedCount;
        }
        return { success: true, affectedRows: total };
      }

      // String WHERE clause. A BLANK/absent WHERE is REFUSED -- it would delete
      // every document. The explicit 1=1 tautology (truncate()'s spelling) is
      // the ONE intentional whole-collection delete: the WHERE is present and
      // non-blank, so it is NOT a filterless write -- deleteMany({}) empties the
      // collection, matching Python/PHP/Ruby (where "1 = 1" translates to an
      // empty match-all filter). An unparseable WHERE still throws in
      // parseWhereClause below.
      if (typeof filter === "string") {
        if (!filter.trim()) {
          requireWriteFilter({}, "DELETE", table); // always throws: no filter
        }
        if (isMatchAllWhere(filter.trim())) {
          const r = await col.deleteMany({}, { session: this.session });
          return { success: true, affectedRows: r.deletedCount };
        }
        const { filter: parsedFilter } = parseWhereClause(filter, []);
        requireWriteFilter(parsedFilter, "DELETE", table);
        const r = await col.deleteMany(parsedFilter, { session: this.session });
        return { success: true, affectedRows: r.deletedCount };
      }

      requireWriteFilter(filter as Record<string, unknown>, "DELETE", table);
      const result = await col.deleteMany(filter as Record<string, unknown>, { session: this.session });
      return { success: true, affectedRows: result.deletedCount };
    } catch (e) {
      return { success: false, affectedRows: 0, error: (e as Error).message };
    }
  }

  startTransaction(): void {
    throw new Error("Use startTransactionAsync() for MongoDB — async adapter requires async methods.");
  }

  async startTransactionAsync(): Promise<void> {
    this.ensureConnected();
    if (this._inTransaction) return;
    this.session = this.client.startSession();
    this.session.startTransaction();
    this._inTransaction = true;
  }

  commit(): void {
    throw new Error("Use commitAsync() for MongoDB — async adapter requires async methods.");
  }

  async commitAsync(): Promise<void> {
    if (!this._inTransaction || !this.session) return;
    await this.session.commitTransaction();
    await this.session.endSession();
    this.session = null;
    this._inTransaction = false;
  }

  rollback(): void {
    throw new Error("Use rollbackAsync() for MongoDB — async adapter requires async methods.");
  }

  async rollbackAsync(): Promise<void> {
    if (!this._inTransaction || !this.session) return;
    try {
      await this.session.abortTransaction();
    } catch {
      // Ignore rollback failures
    }
    await this.session.endSession();
    this.session = null;
    this._inTransaction = false;
  }

  getTables(): string[] {
    throw new Error("Use tablesAsync() for MongoDB — async adapter requires async methods.");
  }

  async tablesAsync(): Promise<string[]> {
    this.ensureConnected();
    const collections = await this.db.listCollections().toArray();
    return collections.map((c: any) => c.name as string);
  }

  getColumns(table: string): ColumnInfo[] {
    throw new Error("Use columnsAsync() for MongoDB — async adapter requires async methods.");
  }

  /**
   * Infer column schema by sampling a document from the collection.
   * MongoDB is schema-less; this returns field names and inferred JS types.
   */
  async columnsAsync(table: string): Promise<ColumnInfo[]> {
    this.ensureConnected();
    const doc = await this.db.collection(table).findOne({});
    if (!doc) return [];
    return Object.entries(doc).map(([key, value]) => ({
      name: key,
      type: typeof value === "number"
        ? "number"
        : typeof value === "boolean"
          ? "boolean"
          : value instanceof Date
            ? "datetime"
            : "string",
      nullable: true,
      default: undefined,
      primaryKey: key === "_id",
    }));
  }

  lastInsertId(): number | bigint | null {
    return this._lastInsertId;
  }

  close(): void {
    if (this.client) {
      // MongoDB client.close() is async but we match the sync interface
      this.client.close().catch(() => {});
      this.client = null;
      this.db = null;
    }
  }

  tableExists(name: string): boolean {
    throw new Error("Use tableExistsAsync() for MongoDB — async adapter requires async methods.");
  }

  async tableExistsAsync(name: string): Promise<boolean> {
    const tables = await this.tablesAsync();
    return tables.includes(name);
  }

  createTable(name: string, columns: Record<string, FieldDefinition>): void {
    throw new Error("Use createTableAsync() for MongoDB — async adapter requires async methods.");
  }

  /**
   * Create a MongoDB collection with optional JSON schema validation derived
   * from the Tina4 field definitions.
   */
  async createTableAsync(name: string, columns: Record<string, FieldDefinition>): Promise<void> {
    this.ensureConnected();

    // Only create if not already present
    const exists = await this.tableExistsAsync(name);
    if (exists) return;

    // Build a JSON Schema validator
    const required: string[] = [];
    const properties: Record<string, unknown> = {};

    for (const [colName, def] of Object.entries(columns)) {
      if (def.required && !def.primaryKey) {
        required.push(colName);
      }
      properties[colName] = fieldTypeToJsonSchema(def);
    }

    const validator = {
      $jsonSchema: {
        bsonType: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    };

    await this.db.createCollection(name, { validator });
  }

  /** Get column info as a plain array (legacy migration support). */
  async getTableColumnsAsync(table: string): Promise<Array<{ name: string; type: string }>> {
    const cols = await this.columnsAsync(table);
    return cols.map((c) => ({ name: c.name, type: c.type }));
  }
}

function fieldTypeToJsonSchema(def: FieldDefinition): Record<string, unknown> {
  switch (def.type) {
    case "integer":
      return { bsonType: "int" };
    case "number":
    case "numeric":
      return { bsonType: "double" };
    case "boolean":
      return { bsonType: "bool" };
    case "datetime":
      return { bsonType: "date" };
    case "text":
      return { bsonType: "string" };
    case "string":
      return def.maxLength
        ? { bsonType: "string", maxLength: def.maxLength }
        : { bsonType: "string" };
    default:
      return { bsonType: "string" };
  }
}
