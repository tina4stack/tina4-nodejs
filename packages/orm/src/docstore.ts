/**
 * Tina4 DocStore - pymongo-style document storage with a zero-config SQLite (JSON1) fallback.
 *
 * A document store with the everyday MongoDB driver collection API, backed by
 * SQLite's JSON1 extension when no MongoDB server is configured.
 *
 *     import { getCollection, ObjectId } from "@tina4/orm";
 *
 *     const orders = await getCollection("orders");    // SqliteCollection when no Mongo configured
 *     const { insertedId } = await orders.insertOne({ customer_id: 1, total: 9.99 });
 *     for (const o of await orders.find({ customer_id: { $in: [1, 2] } }).sort("created_at", -1).limit(10).toArray()) {
 *       // ...
 *     }
 *     await orders.updateOne({ _id: insertedId }, { $set: { status: "shipped" } });
 *
 * `getCollection(name)` returns a real MongoDB driver `Collection` when a Mongo
 * URI is configured (TINA4_MONGO_URI, else TINA4_SESSION_MONGO_URI - the same
 * names the queue/session Mongo backends read), and otherwise a SqliteCollection
 * backed by a local SQLite file. This mirrors the file-based fallbacks the queue,
 * cache, and session subsystems already provide: an app that talks to Mongo in
 * production runs serverless in local dev with no code change - only the backend
 * differs.
 *
 * Design (the SQLite backend):
 *   - Each collection is a table `(_id TEXT PRIMARY KEY, doc TEXT)`; `doc` is JSON.
 *   - Query filters are pushed down to SQL over `json_extract(doc, '$.field')`
 *     (lazy, not a full in-memory scan), supporting equality, $in/$nin,
 *     $gt/$gte/$lt/$lte, $ne, $exists, $regex, and implicit-AND / $or / $and.
 *   - Updates: $set, $unset, $inc, and full-document replace.
 *   - Cursors: sort / limit / skip / projection.
 *   - IDs are a built-in 12-byte ObjectId (zero-dependency; interchangeable with
 *     the driver's ObjectId as a 24-hex string).
 *
 * Type round-trip is by value, not by wrapper object, so json_extract stays
 * queryable and sortable: a Date is stored as an ISO-8601 UTC string and an
 * ObjectId as its 24-hex string, and reads rehydrate a strict-ISO string back to
 * a Date and a 24-hex string back to an ObjectId. That keeps range queries and
 * sorts working on date and id fields - the trade-off (a plain 24-hex / ISO
 * string becomes an ObjectId / Date on read) is acceptable for the local dev store.
 *
 * Deliberate non-goals: aggregation pipeline, $elemMatch, geo. This is the
 * everyday CRUD + filter subset, not full Mongo parity.
 */
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

// ── ObjectId: zero-dependency 12-byte / 24-hex id ──────────────────────────

/** Raised when a value cannot be parsed as an ObjectId. */
export class InvalidId extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidId";
  }
}

const OID_RE = /^[0-9a-fA-F]{24}$/;
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

/**
 * A 12-byte MongoDB-style ObjectId, with no external dependency.
 *
 * Layout: 4-byte big-endian seconds since epoch, 5-byte per-process random,
 * 3-byte big-endian counter. Renders as a 24-char hex string, so it is
 * interchangeable with the driver's ObjectId wherever the string form is used.
 */
export class ObjectId {
  private static _counter = randomBytes(3).readUIntBE(0, 3);
  private static _process = randomBytes(5);

  private readonly _bytes: Buffer;

  constructor(oid?: ObjectId | Buffer | Uint8Array | string | null) {
    if (oid === undefined || oid === null) {
      this._bytes = ObjectId._generate();
    } else if (oid instanceof ObjectId) {
      this._bytes = Buffer.from(oid._bytes);
    } else if (oid instanceof Buffer || oid instanceof Uint8Array) {
      if (oid.length !== 12) {
        throw new InvalidId("ObjectId bytes must be exactly 12 bytes");
      }
      this._bytes = Buffer.from(oid);
    } else if (typeof oid === "string") {
      if (!OID_RE.test(oid)) {
        throw new InvalidId(`'${oid}' is not a valid 24-character hex ObjectId`);
      }
      this._bytes = Buffer.from(oid, "hex");
    } else {
      throw new InvalidId(`cannot make an ObjectId from ${typeof oid}`);
    }
  }

  private static _generate(): Buffer {
    const buf = Buffer.alloc(12);
    buf.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
    ObjectId._process.copy(buf, 4);
    ObjectId._counter = (ObjectId._counter + 1) & 0xffffff;
    buf.writeUIntBE(ObjectId._counter, 9, 3);
    return buf;
  }

  static isValid(value: unknown): boolean {
    try {
      // eslint-disable-next-line no-new
      new ObjectId(value as never);
      return true;
    } catch {
      return false;
    }
  }

  get binary(): Buffer {
    return this._bytes;
  }

  /** The timestamp embedded in the id (the first 4 bytes), as a Date. */
  get generationTime(): Date {
    const ts = this._bytes.readUInt32BE(0);
    return new Date(ts * 1000);
  }

  toString(): string {
    return this._bytes.toString("hex");
  }

  toJSON(): string {
    return this.toString();
  }

  equals(other: unknown): boolean {
    return other instanceof ObjectId && other._bytes.equals(this._bytes);
  }
}

// ── Value encoding: keep scalars queryable, rehydrate types on read ─────────

function iso(d: Date): string {
  // Date.toISOString() is always UTC with a Z suffix.
  return d.toISOString();
}

/** Value -> JSON-serialisable, sortable scalar form (for storage/queries). */
export function encodeValue(value: unknown): unknown {
  if (value instanceof ObjectId) return value.toString();
  if (value instanceof Date) return iso(value);
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = encodeValue(v);
    }
    return out;
  }
  return value;
}

/** Stored JSON value -> rich value, rehydrating ObjectId (24-hex) and Date (ISO). */
export function decodeValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (OID_RE.test(value)) return new ObjectId(value);
    if (ISO_RE.test(value)) {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? value : d;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = decodeValue(v);
    }
    return out;
  }
  return value;
}

/** Canonical string key for the _id column. */
function idKey(value: unknown): string {
  if (value instanceof ObjectId) return value.toString();
  if (value instanceof Date) return iso(value);
  return String(value);
}

// ── Query translation: Mongo filter -> SQL WHERE over json_extract ──────────

const COMPARATORS: Record<string, string> = {
  $gt: ">",
  $gte: ">=",
  $lt: "<",
  $lte: "<=",
};

/** Field name -> a JSON path. Dotted names address nested keys. */
function jsonPath(field: string): string {
  const segments = field.split(".");
  const isIdent = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
  return "$." + segments.map((s) => (isIdent(s) ? s : `"${s}"`)).join(".");
}

function extract(field: string): string {
  return `json_extract(doc, '${jsonPath(field)}')`;
}

function typeOf(field: string): string {
  return `json_type(doc, '${jsonPath(field)}')`;
}

/** Bind a value for comparison against json_extract output. */
function bind(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ObjectId || value instanceof Date) return encodeValue(value);
  if (value === null || ["number", "string", "bigint"].includes(typeof value)) {
    return value;
  }
  return JSON.stringify(encodeValue(value));
}

interface CompiledFilter {
  where: string;
  params: unknown[];
}

/**
 * Compile a Mongo-style filter object into { where, params }.
 *
 * Returns { where: "1=1", params: [] } for an empty filter. Supports implicit
 * AND across keys, $or / $and, and the per-field operator set.
 */
export function compileFilter(query?: Record<string, unknown> | null): CompiledFilter {
  if (!query || Object.keys(query).length === 0) {
    return { where: "1=1", params: [] };
  }

  const clauses: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(query)) {
    if (key === "$or" || key === "$and") {
      const joiner = key === "$or" ? " OR " : " AND ";
      const subs: string[] = [];
      for (const sub of value as Record<string, unknown>[]) {
        const compiled = compileFilter(sub);
        subs.push(`(${compiled.where})`);
        params.push(...compiled.params);
      }
      if (subs.length) clauses.push("(" + subs.join(joiner) + ")");
      continue;
    }

    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof ObjectId) &&
      !(value instanceof Date) &&
      Object.keys(value).length > 0 &&
      Object.keys(value).every((k) => k.startsWith("$"))
    ) {
      for (const [op, operand] of Object.entries(value as Record<string, unknown>)) {
        const compiled = compileOp(key, op, operand);
        clauses.push(compiled.where);
        params.push(...compiled.params);
      }
    } else if (value === null) {
      clauses.push(`${extract(key)} IS NULL`);
    } else {
      clauses.push(`${extract(key)} = ?`);
      params.push(bind(value));
    }
  }

  return { where: clauses.length ? clauses.join(" AND ") : "1=1", params };
}

function compileOp(field: string, op: string, operand: unknown): CompiledFilter {
  const ex = extract(field);
  if (op in COMPARATORS) {
    return { where: `${ex} ${COMPARATORS[op]} ?`, params: [bind(operand)] };
  }
  if (op === "$eq") {
    if (operand === null) return { where: `${ex} IS NULL`, params: [] };
    return { where: `${ex} = ?`, params: [bind(operand)] };
  }
  if (op === "$ne") {
    if (operand === null) return { where: `${ex} IS NOT NULL`, params: [] };
    return { where: `(${ex} <> ? OR ${ex} IS NULL)`, params: [bind(operand)] };
  }
  if (op === "$in") {
    const items = Array.isArray(operand) ? operand : [];
    if (items.length === 0) return { where: "0", params: [] };
    const placeholders = items.map(() => "?").join(",");
    return { where: `${ex} IN (${placeholders})`, params: items.map(bind) };
  }
  if (op === "$nin") {
    const items = Array.isArray(operand) ? operand : [];
    if (items.length === 0) return { where: "1", params: [] };
    const placeholders = items.map(() => "?").join(",");
    return { where: `(${ex} NOT IN (${placeholders}) OR ${ex} IS NULL)`, params: items.map(bind) };
  }
  if (op === "$exists") {
    // json_type is NULL when the path is absent; present-but-null still has a type.
    return { where: operand ? `${typeOf(field)} IS NOT NULL` : `${typeOf(field)} IS NULL`, params: [] };
  }
  if (op === "$regex") {
    let pattern = operand;
    if (operand !== null && typeof operand === "object") {
      pattern = (operand as Record<string, unknown>).$regex ?? "";
    }
    return { where: `${ex} REGEXP ?`, params: [String(pattern)] };
  }
  throw new Error(`DocStore: unsupported query operator '${op}'`);
}

// ── Update + projection helpers ─────────────────────────────────────────────

function project(doc: Record<string, unknown>, projection?: Record<string, unknown> | null): Record<string, unknown> {
  if (!projection || Object.keys(projection).length === 0) return doc;
  const include = new Set(
    Object.entries(projection).filter(([k, v]) => v && k !== "_id").map(([k]) => k),
  );
  const exclude = new Set(Object.entries(projection).filter(([, v]) => !v).map(([k]) => k));
  if (include.size > 0) {
    const out: Record<string, unknown> = {};
    for (const k of include) if (k in doc) out[k] = doc[k];
    const idVal = projection._id;
    if ((idVal === undefined || idVal) && "_id" in doc) out._id = doc._id;
    return out;
  }
  // exclusion projection
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (!exclude.has(k)) out[k] = v;
  return out;
}

function setPath(doc: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let node = doc;
  for (const p of parts.slice(0, -1)) {
    if (node[p] === undefined || node[p] === null || typeof node[p] !== "object") {
      node[p] = {};
    }
    node = node[p] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

function unsetPath(doc: Record<string, unknown>, dotted: string): void {
  const parts = dotted.split(".");
  let node: Record<string, unknown> | undefined = doc;
  for (const p of parts.slice(0, -1)) {
    const next = node[p];
    if (next === null || typeof next !== "object") return;
    node = next as Record<string, unknown>;
  }
  if (node) delete node[parts[parts.length - 1]];
}

function getPath(doc: Record<string, unknown>, dotted: string): unknown {
  const parts = dotted.split(".");
  let node: unknown = doc;
  for (const p of parts) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[p];
  }
  return node;
}

function applyUpdate(doc: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  const hasOps = Object.keys(update).some((k) => k.startsWith("$"));
  if (!hasOps) {
    // full-document replace (keep the existing _id)
    const next: Record<string, unknown> = { ...update };
    if (!("_id" in next)) next._id = doc._id;
    return next;
  }
  const next: Record<string, unknown> = { ...doc };
  for (const [op, fields] of Object.entries(update)) {
    const fieldObj = fields as Record<string, unknown>;
    if (op === "$set") {
      for (const [k, v] of Object.entries(fieldObj)) setPath(next, k, v);
    } else if (op === "$unset") {
      for (const k of Object.keys(fieldObj)) unsetPath(next, k);
    } else if (op === "$inc") {
      for (const [k, v] of Object.entries(fieldObj)) {
        const current = getPath(next, k);
        setPath(next, k, (typeof current === "number" ? current : 0) + (v as number));
      }
    } else {
      throw new Error(`DocStore: unsupported update operator '${op}'`);
    }
  }
  return next;
}

// ── Result shapes (mirror the Mongo driver) ─────────────────────────────────

export interface InsertOneResult {
  acknowledged: boolean;
  insertedId: unknown;
}
export interface InsertManyResult {
  acknowledged: boolean;
  insertedIds: unknown[];
}
export interface UpdateResult {
  acknowledged: boolean;
  matchedCount: number;
  modifiedCount: number;
  upsertedId: unknown | null;
}
export interface DeleteResult {
  acknowledged: boolean;
  deletedCount: number;
}

// ── Cursor ───────────────────────────────────────────────────────────────────

/** Lazy result cursor. Builds and runs SQL only when materialised (toArray). */
export class Cursor {
  private _sort: [string, number][] = [];
  private _limit: number | null = null;
  private _skip = 0;

  constructor(
    private readonly collection: SqliteCollection,
    private readonly where: string,
    private readonly params: unknown[],
    private readonly projection?: Record<string, unknown> | null,
  ) {}

  sort(keyOrList: string | [string, number][], direction = 1): this {
    if (typeof keyOrList === "string") {
      this._sort.push([keyOrList, direction]);
    } else {
      for (const [k, d] of keyOrList) this._sort.push([k, d]);
    }
    return this;
  }

  limit(n: number): this {
    this._limit = Math.trunc(n);
    return this;
  }

  skip(n: number): this {
    this._skip = Math.trunc(n);
    return this;
  }

  private buildSql(): string {
    let sql = `SELECT doc FROM ${this.collection.quoted} WHERE ${this.where}`;
    if (this._sort.length) {
      const order = this._sort
        .map(([k, d]) => `${extract(k)} ${d < 0 ? "DESC" : "ASC"}`)
        .join(", ");
      sql += ` ORDER BY ${order}`;
    }
    if (this._limit !== null) {
      sql += ` LIMIT ${Math.trunc(this._limit)}`;
      if (this._skip) sql += ` OFFSET ${Math.trunc(this._skip)}`;
    } else if (this._skip) {
      sql += ` LIMIT -1 OFFSET ${Math.trunc(this._skip)}`;
    }
    return sql;
  }

  /**
   * Materialise the cursor into an array of decoded documents.
   *
   * ASYNC because the driver's FindCursor.toArray() is async (ADR-0025 clause
   * 3). The work underneath is synchronous - node:sqlite has no async API - but
   * the SHAPE is what a call site sees, and a shape that changes with the
   * provider is the defect this fixes.
   */
  async toArray(): Promise<Record<string, unknown>[]> {
    const rows = this.collection.connection
      .prepare(this.buildSql())
      .all(...(this.params as never[])) as { doc: string }[];
    return rows.map((r) => this.collection.load(r.doc, this.projection));
  }

  /**
   * Async iteration, matching the driver.
   *
   * NOTE: there is deliberately no [Symbol.iterator] here. A real FindCursor
   * has ONLY Symbol.asyncIterator, so `for (const doc of cursor)` is a
   * fallback-only spelling - it works locally and throws "is not iterable" the
   * moment TINA4_MONGO_URI is set. Use `for await (const doc of cursor)`.
   *
   * toList() is gone for the same reason: the driver's FindCursor has no such
   * method.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    for (const doc of await this.toArray()) yield doc;
  }
}

// ── Collection ─────────────────────────────────────────────────────────────

/** A SQLite-backed collection exposing the everyday MongoDB driver API. */
export class SqliteCollection {
  readonly quoted: string;

  constructor(
    readonly connection: DatabaseSync,
    private readonly name: string,
  ) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`DocStore: invalid collection name '${name}'`);
    }
    this.quoted = `"${name}"`;
    this.connection.exec(
      `CREATE TABLE IF NOT EXISTS ${this.quoted} (_id TEXT PRIMARY KEY, doc TEXT NOT NULL)`,
    );
  }

  private dump(document: Record<string, unknown>): string {
    return JSON.stringify(encodeValue(document));
  }

  /** Decode a stored JSON document (rehydrating ObjectId/Date), with optional projection. */
  load(docText: string, projection?: Record<string, unknown> | null): Record<string, unknown> {
    const doc = decodeValue(JSON.parse(docText)) as Record<string, unknown>;
    return projection ? project(doc, projection) : doc;
  }

  // -- writes --
  async insertOne(document: Record<string, unknown>): Promise<InsertOneResult> {
    const doc = { ...document };
    if (!("_id" in doc)) doc._id = new ObjectId();
    this.connection
      .prepare(`INSERT INTO ${this.quoted} (_id, doc) VALUES (?, ?)`)
      .run(idKey(doc._id), this.dump(doc));
    return { acknowledged: true, insertedId: doc._id };
  }

  async insertMany(documents: Record<string, unknown>[]): Promise<InsertManyResult> {
    const ids: unknown[] = [];
    const stmt = this.connection.prepare(`INSERT INTO ${this.quoted} (_id, doc) VALUES (?, ?)`);
    for (const document of documents) {
      const doc = { ...document };
      if (!("_id" in doc)) doc._id = new ObjectId();
      ids.push(doc._id);
      stmt.run(idKey(doc._id), this.dump(doc));
    }
    return { acknowledged: true, insertedIds: ids };
  }

  // -- reads --
  find(filter?: Record<string, unknown> | null, projection?: Record<string, unknown> | null): Cursor {
    const { where, params } = compileFilter(filter ?? {});
    return new Cursor(this, where, params, projection);
  }

  async findOne(
    filter?: Record<string, unknown> | null,
    projection?: Record<string, unknown> | null,
  ): Promise<Record<string, unknown> | null> {
    const results = await this.find(filter, projection).limit(1).toArray();
    return results.length ? results[0] : null;
  }

  async countDocuments(filter?: Record<string, unknown> | null): Promise<number> {
    const { where, params } = compileFilter(filter ?? {});
    const row = this.connection
      .prepare(`SELECT count(*) AS c FROM ${this.quoted} WHERE ${where}`)
      .get(...(params as never[])) as { c: number | bigint };
    return Number(row.c);
  }

  async estimatedDocumentCount(): Promise<number> {
    const row = this.connection
      .prepare(`SELECT count(*) AS c FROM ${this.quoted}`)
      .get() as { c: number | bigint };
    return Number(row.c);
  }

  async distinct(key: string, filter?: Record<string, unknown> | null): Promise<unknown[]> {
    const seen: unknown[] = [];
    for (const doc of await this.find(filter).toArray()) {
      const v = doc[key];
      if (!seen.some((s) => valuesEqual(s, v))) seen.push(v);
    }
    return seen;
  }

  // -- updates (filter pushed to SQL; mutation applied per matched doc) --
  private matchingRows(filter?: Record<string, unknown> | null): { _id: string; doc: string }[] {
    const { where, params } = compileFilter(filter ?? {});
    return this.connection
      .prepare(`SELECT _id, doc FROM ${this.quoted} WHERE ${where}`)
      .all(...(params as never[])) as { _id: string; doc: string }[];
  }

  private firstMatch(filter?: Record<string, unknown> | null): { _id: string; doc: string } | null {
    const { where, params } = compileFilter(filter ?? {});
    const row = this.connection
      .prepare(`SELECT _id, doc FROM ${this.quoted} WHERE ${where} LIMIT 1`)
      .get(...(params as never[])) as { _id: string; doc: string } | undefined;
    return row ?? null;
  }

  private writeBack(oldId: string, newDoc: Record<string, unknown>): void {
    this.connection
      .prepare(`UPDATE ${this.quoted} SET _id = ?, doc = ? WHERE _id = ?`)
      .run(idKey(newDoc._id), this.dump(newDoc), oldId);
  }

  private async doUpsert(filter: Record<string, unknown> | null | undefined, update: Record<string, unknown>): Promise<UpdateResult> {
    // Seed a document from the filter's equality terms, then apply the update.
    const seed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(filter ?? {})) {
      if (!k.startsWith("$") && !(v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof ObjectId) && !(v instanceof Date))) {
        seed[k] = v;
      }
    }
    const doc = applyUpdate(seed, update);
    if (!("_id" in doc)) doc._id = new ObjectId();
    await this.insertOne(doc);
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: doc._id };
  }

  async updateOne(
    filter: Record<string, unknown> | null | undefined,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<UpdateResult> {
    const row = this.firstMatch(filter);
    if (!row) {
      if (options?.upsert) return this.doUpsert(filter, update);
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
    }
    const doc = decodeValue(JSON.parse(row.doc)) as Record<string, unknown>;
    const newDoc = applyUpdate(doc, update);
    this.writeBack(row._id, newDoc);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null };
  }

  async updateMany(
    filter: Record<string, unknown> | null | undefined,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<UpdateResult> {
    const rows = this.matchingRows(filter);
    if (rows.length === 0 && options?.upsert) return this.doUpsert(filter, update);
    let matched = 0;
    let modified = 0;
    for (const row of rows) {
      matched += 1;
      const doc = decodeValue(JSON.parse(row.doc)) as Record<string, unknown>;
      const newDoc = applyUpdate(doc, update);
      this.writeBack(row._id, newDoc);
      modified += 1;
    }
    return { acknowledged: true, matchedCount: matched, modifiedCount: modified, upsertedId: null };
  }

  async replaceOne(
    filter: Record<string, unknown> | null | undefined,
    replacement: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<UpdateResult> {
    const row = this.firstMatch(filter);
    if (!row) {
      if (options?.upsert) {
        const doc = { ...replacement };
        if (!("_id" in doc)) doc._id = new ObjectId();
        await this.insertOne(doc);
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: doc._id };
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
    }
    const doc = { ...replacement };
    if (!("_id" in doc)) {
      const existing = decodeValue(JSON.parse(row.doc)) as Record<string, unknown>;
      doc._id = existing._id;
    }
    this.writeBack(row._id, doc);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null };
  }

  // -- deletes --
  async deleteOne(filter?: Record<string, unknown> | null): Promise<DeleteResult> {
    const row = this.firstMatch(filter);
    if (!row) return { acknowledged: true, deletedCount: 0 };
    this.connection.prepare(`DELETE FROM ${this.quoted} WHERE _id = ?`).run(row._id);
    return { acknowledged: true, deletedCount: 1 };
  }

  async deleteMany(filter?: Record<string, unknown> | null): Promise<DeleteResult> {
    const { where, params } = compileFilter(filter ?? {});
    const result = this.connection
      .prepare(`DELETE FROM ${this.quoted} WHERE ${where}`)
      .run(...(params as never[]));
    return { acknowledged: true, deletedCount: Number(result.changes) };
  }

  async drop(): Promise<void> {
    this.connection.exec(`DROP TABLE IF EXISTS ${this.quoted}`);
  }
}

/** Structural equality for distinct() (handles ObjectId / Date by value). */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

// ── REGEXP user function ─────────────────────────────────────────────────────

function regexpFn(pattern: unknown, value: unknown): number {
  if (value === null || value === undefined) return 0;
  try {
    return new RegExp(String(pattern)).test(String(value)) ? 1 : 0;
  } catch {
    return 0;
  }
}

// ── Database + selection ─────────────────────────────────────────────────────

/** Resolve a SQLite path against cwd, auto-mkdir only under cwd. */
function resolveStorePath(dbPath: string): string {
  if (dbPath === ":memory:") return dbPath;
  let path = dbPath;
  if (!isAbsolute(path)) {
    path = join(process.cwd(), path);
    mkdirSync(dirname(path), { recursive: true });
  }
  return path;
}

/** A SQLite-backed document database (a file of collection tables). */
export class SqliteDatabase {
  readonly path: string;
  private readonly conn: DatabaseSync;
  private readonly collections = new Map<string, SqliteCollection>();

  constructor(path?: string) {
    this.path = path || process.env.TINA4_DOC_STORE_PATH || "data/tina4_docstore.db";
    const resolved = resolveStorePath(this.path);
    this.conn = new DatabaseSync(resolved);
    this.conn.function("regexp", regexpFn);
  }

  getCollection(name: string): SqliteCollection {
    let col = this.collections.get(name);
    if (!col) {
      col = new SqliteCollection(this.conn, name);
      this.collections.set(name, col);
    }
    return col;
  }

  listCollectionNames(): string[] {
    const rows = this.conn
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  close(): void {
    this.conn.close();
  }
}

/**
 * The configured Mongo URI, reusing the app-wide queue/session env vars.
 * Canonical TINA4_SESSION_MONGO_URI; TINA4_SESSION_MONGO_URL is a legacy alias.
 */
function mongoUri(): string {
  return (
    process.env.TINA4_MONGO_URI ||
    process.env.TINA4_SESSION_MONGO_URI ||
    process.env.TINA4_SESSION_MONGO_URL ||
    ""
  ).trim();
}

/** True when no Mongo is configured, so the SQLite fallback is in effect. */
export function isServerless(): boolean {
  if (!mongoUri()) return true;
  // A URI is set: the real-Mongo path is used (the `mongodb` driver is resolved
  // lazily inside getCollection). isServerless() reflects only the configuration.
  return false;
}

let defaultDb: SqliteDatabase | null = null;

function getDb(): SqliteDatabase {
  if (defaultDb === null) defaultDb = new SqliteDatabase();
  return defaultDb;
}

/**
 * Return a collection for `name`.
 *
 * A real MongoDB driver `Collection` when a Mongo URI is configured (and the
 * `mongodb` driver is installed); otherwise a `SqliteCollection` backed by the
 * local SQLite file. Same call sites either way - only the backend differs.
 *
 * ALWAYS async, on BOTH providers (ADR-0025 clause 3).
 *
 * It used to return a SqliteCollection SYNCHRONOUSLY in serverless mode and a
 * Promise on the real-Mongo path. That made identical source change TYPE when
 * TINA4_MONGO_URI was set, and a Promise is always truthy - so un-awaited code
 * read a real document locally and a thenable in production, and `if (doc)`
 * succeeded for a document that did not exist. The driver cannot become sync,
 * so the fallback becomes async.
 */
export async function getCollection(name: string): Promise<SqliteCollection | unknown> {
  if (isServerless()) {
    return getDb().getCollection(name);
  }
  const dbName = process.env.TINA4_MONGO_DB || process.env.TINA4_SESSION_MONGO_DB || "tina4";
  const { db } = await mongoConnection(mongoUri(), dbName);
  return db.collection(name);
}

/** One connected client per (uri, database), keyed so a reconfigure gets its own. */
const mongoClients = new Map<string, Promise<{ client: any; db: any }>>();

/**
 * Return the shared client for this (uri, database), connecting once.
 *
 * MEASURED 2026-08-03 against a real MongoDB: getCollection() used to construct
 * a `new MongoClient` on EVERY call and never close it, so 20 calls left 40
 * server connections open and the count grew without bound. It was invisible in
 * development because the SQLite fallback has no connections at all - a resource
 * leak that only exists AFTER the swap to the real provider.
 *
 * The map holds the in-flight PROMISE rather than the resolved client. Caching
 * the resolved value would leave a check-then-act window in which two
 * concurrent callers both miss the cache and both build a client - which is the
 * same leak, just rarer and harder to see. A failed connect is evicted so a
 * transient outage cannot poison the entry for the life of the process.
 */
function mongoConnection(uri: string, dbName: string): Promise<{ client: any; db: any }> {
  const key = `${uri} ${dbName}`;
  let pending = mongoClients.get(key);
  if (!pending) {
    pending = (async () => {
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(uri);
      await client.connect();
      return { client, db: client.db(dbName) };
    })();
    mongoClients.set(key, pending);
    pending.catch(() => mongoClients.delete(key));
  }
  return pending;
}

/**
 * Close every DocStore connection: the SQLite store and all Mongo clients.
 *
 * A pooled client keeps the event loop alive, so a script or test that touches
 * the real provider needs a way to let the process end on its own.
 */
export async function closeDocStore(): Promise<void> {
  const pending = [...mongoClients.values()];
  mongoClients.clear();
  await Promise.allSettled(
    pending.map(async (p) => {
      const { client } = await p;
      await client.close();
    }),
  );
  resetDefaultStore();
}

/** Drop the cached default SQLite store (test helper). */
export function resetDefaultStore(): void {
  if (defaultDb !== null) {
    defaultDb.close();
    defaultDb = null;
  }
}
