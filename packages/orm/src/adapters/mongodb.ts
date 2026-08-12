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
}

/** Convert SQL WHERE clause tokens into a MongoDB filter object. */
function parseWhereClause(where: string, params: unknown[], paramOffset = 0): { filter: Record<string, unknown>; consumed: number } {
  const filter: Record<string, unknown> = {};
  // Simple key = ? / key = 'value' patterns separated by AND
  const parts = where.split(/\s+AND\s+/i);
  let paramIndex = paramOffset;

  for (const part of parts) {
    const trimmed = part.trim();

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
 * updateMany({}) would wipe or rewrite the whole collection. Refuse it. The
 * explicit whole-collection spelling is truncate() (it passes WHERE 1 = 1, which
 * translates to a non-empty { "1": 1 } filter); the raw driver is the escape
 * hatch for anything the SQL subset cannot express. Shared by both write paths
 * so the guard cannot drift.
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

/** Parse a SQL string into a MongoOperation. Returns null if parsing is not supported. */
function parseSql(sql: string, params: unknown[] = []): MongoOperation | null {
  const s = sql.trim();

  // ---- SELECT ----
  const selectMatch = s.match(
    /^SELECT\s+(.*?)\s+FROM\s+["']?(\w+)["']?(?:\s+WHERE\s+(.*?))?(?:\s+ORDER\s+BY\s+(.*?))?(?:\s+LIMIT\s+(\d+))?(?:\s+OFFSET\s+(\d+))?$/is,
  );
  if (selectMatch) {
    const [, cols, collection, whereClause, orderBy, limitStr, skipStr] = selectMatch;

    // Projection
    let projection: Record<string, unknown> | undefined;
    if (cols && cols.trim() !== "*") {
      projection = {};
      for (const col of cols.split(",")) {
        const name = col.trim().replace(/^["']|["']$/g, "");
        if (name && name !== "*") projection[name] = 1;
      }
    }

    // Filter
    let filter: Record<string, unknown> = {};
    if (whereClause) {
      const parsed = parseWhereClause(whereClause.trim(), params);
      filter = parsed.filter;
    }

    // Sort
    let sort: Record<string, 1 | -1> | undefined;
    if (orderBy) {
      sort = {};
      for (const part of orderBy.split(",")) {
        const t = part.trim();
        const desc = /DESC$/i.test(t);
        const col = t.replace(/\s+(ASC|DESC)$/i, "").replace(/^["']|["']$/g, "").trim();
        sort[col] = desc ? -1 : 1;
      }
    }

    return {
      type: "find",
      collection,
      filter,
      projection: projection && Object.keys(projection).length > 0 ? projection : undefined,
      limit: limitStr ? parseInt(limitStr, 10) : undefined,
      skip: skipStr ? parseInt(skipStr, 10) : undefined,
      sort,
    };
  }

  // ---- INSERT ----
  const insertMatch = s.match(
    /^INSERT\s+INTO\s+["']?(\w+)["']?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)$/is,
  );
  if (insertMatch) {
    const [, collection, colsStr, valsStr] = insertMatch;
    const cols = colsStr.split(",").map((c) => c.trim().replace(/^["']|["']$/g, ""));
    const valPlaceholders = valsStr.split(",").map((v) => v.trim());
    let paramIndex = 0;
    const doc: Record<string, unknown> = {};
    for (let i = 0; i < cols.length; i++) {
      if (valPlaceholders[i] === "?") {
        doc[cols[i]] = params[paramIndex++];
      } else if (/^'.*'$/.test(valPlaceholders[i])) {
        doc[cols[i]] = valPlaceholders[i].slice(1, -1);
      } else if (/^-?\d+(\.\d+)?$/.test(valPlaceholders[i])) {
        doc[cols[i]] = Number(valPlaceholders[i]);
      } else {
        doc[cols[i]] = valPlaceholders[i];
      }
    }
    return { type: "insertOne", collection, document: doc };
  }

  // ---- UPDATE ----
  // WHERE is OPTIONAL in the grammar so a filterless UPDATE ("UPDATE t SET x=1")
  // is RECOGNISED as an updateMany with an empty filter and reaches the
  // fail-closed guard -- rather than failing the regex, returning null, and
  // being silently acknowledged as a no-op (a silent wrong result).
  const updateMatch = s.match(
    /^UPDATE\s+["']?(\w+)["']?\s+SET\s+(.*?)(?:\s+WHERE\s+(.+))?$/is,
  );
  if (updateMatch) {
    const [, collection, setClause, whereClause] = updateMatch;

    // Parse SET clause
    const setDoc: Record<string, unknown> = {};
    let setParamIndex = 0;
    for (const setPart of setClause.split(",")) {
      const m = setPart.trim().match(/^["']?(\w+)["']?\s*=\s*\?$/);
      if (m) {
        setDoc[m[1]] = params[setParamIndex++];
      } else {
        const mLit = setPart.trim().match(/^["']?(\w+)["']?\s*=\s*(?:'([^']*)'|(-?\d+(?:\.\d+)?))$/);
        if (mLit) {
          setDoc[mLit[1]] = mLit[2] !== undefined ? mLit[2] : Number(mLit[3]);
        }
      }
    }

    // Parse WHERE clause (params start after SET params). No WHERE -> empty
    // filter, which the write guard refuses.
    const filter = whereClause
      ? parseWhereClause(whereClause.trim(), params, setParamIndex).filter
      : {};

    return { type: "updateMany", collection, filter, update: { $set: setDoc } };
  }

  // ---- DELETE ----
  const deleteMatch = s.match(
    /^DELETE\s+FROM\s+["']?(\w+)["']?(?:\s+WHERE\s+(.+))?$/is,
  );
  if (deleteMatch) {
    const [, collection, whereClause] = deleteMatch;
    const filter = whereClause
      ? parseWhereClause(whereClause.trim(), params).filter
      : {};
    return { type: "deleteMany", collection, filter };
  }

  // ---- CREATE TABLE (treated as createCollection) ----
  const createTableMatch = s.match(/^CREATE\s+(?:TABLE|COLLECTION)\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/i);
  if (createTableMatch) {
    // We handle this in createTable(); signal it as a "raw" skip
    return { type: "raw", collection: createTableMatch[1] };
  }

  // ---- SELECT COUNT(*) ----
  const countMatch = s.match(/^SELECT\s+COUNT\(\*\)\s+AS\s+(\w+)\s+FROM\s+["']?(\w+)["']?(?:\s+WHERE\s+(.+))?$/is);
  if (countMatch) {
    const [, alias, collection, whereClause] = countMatch;
    const filter = whereClause
      ? parseWhereClause(whereClause.trim(), params).filter
      : {};
    return {
      type: "aggregate",
      collection,
      pipeline: [
        { $match: filter },
        { $count: alias },
      ],
    };
  }

  return null;
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
        requireWriteFilter(op.filter, "UPDATE", op.collection);
        const result = await col.updateMany(op.filter!, op.update!, { session: this.session });
        return result;
      }
      case "deleteMany": {
        requireWriteFilter(op.filter, "DELETE", op.collection);
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

      // String WHERE clause. A BLANK string (or a WHERE that translates to an
      // empty filter) is REFUSED -- it would delete every document. truncate()
      // passes "1 = 1", which translates to a non-empty { "1": 1 } filter, so
      // the explicit whole-collection path still works.
      if (typeof filter === "string") {
        if (!filter.trim()) {
          requireWriteFilter({}, "DELETE", table); // always throws: no filter
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
