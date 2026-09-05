import {
  getAdapter, getNamedAdapter, setAdapter, parseDatabaseUrl,
  adapterQuery, adapterFetch, adapterExecute, adapterFetchOne,
  adapterStartTransaction, adapterCommit, adapterRollback,
  adapterTableExists, adapterCreateTable, extractLastInsertId,
  probeTotal, DEFAULT_ROW_CAP,
} from "./database.js";
import { ModelCollection } from "./modelCollection.js";
import { validate as validateFields } from "./validation.js";
import { QueryBuilder } from "./queryBuilder.js";
import { SQLiteAdapter } from "./adapters/sqlite.js";
import { QueryCache, SQLTranslator } from "./sqlTranslator.js";
import { Log } from "../../core/src/index.js";
import type { DatabaseAdapter, FieldDefinition, RelationshipDefinition } from "./types.js";
import { Point, DEFAULT_SRID, SpatialNotSupportedError } from "./point.js";

/**
 * Convert a snake_case name to camelCase.
 * Lowercases the input first so UPPERCASE DB column names (Firebird/Oracle) map correctly.
 */
export function snakeToCamel(name: string): string {
  return name.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Convert a camelCase name to snake_case.
 */
export function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Convert an in-memory field value to its database representation.
 * A "json" field serialises its object/array to a JSON string for the driver
 * (parity with the Python master's JSONField.to_db). A value that can't be
 * serialised (e.g. a circular reference or a BigInt) throws — save() builds
 * the row inside its try/catch, so it fails loud (rolls back, returns false,
 * records the cause). null/undefined and an already-serialised string pass
 * through untouched. Every other field type is returned as-is.
 */
export function toDbFieldValue(def: FieldDefinition | undefined, value: unknown): unknown {
  if (def?.type === "json" && value !== null && value !== undefined && typeof value !== "string") {
    return JSON.stringify(value);
  }
  if (def?.type === "point" && value !== null && value !== undefined) {
    const point = Point.parse(value, def.srid ?? DEFAULT_SRID);
    if (point.srid !== (def.srid ?? DEFAULT_SRID)) throw new TypeError(`Point field expects SRID ${def.srid ?? DEFAULT_SRID}; received ${point.srid}`);
    return point.ewkt;
  }
  return value;
}

/**
 * Convert a database value to its in-memory representation for a field.
 * A "json" column comes back from the driver as a JSON string (SQLite TEXT,
 * MySQL JSON, PostgreSQL JSONB via the text protocol, MSSQL NVARCHAR); decode
 * it to the object/array the property expects (parity with the Python master's
 * JSONField parse-on-read). A value already an object/array is left untouched;
 * null stays null; a non-decodable string keeps its raw form.
 */
export function fromDbFieldValue(def: FieldDefinition | undefined, value: unknown): unknown {
  if (def?.type === "json" && typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value; // leave the raw string in place
    }
  }
  if (def?.type === "point" && value !== null && value !== undefined) {
    const point = Point.parse(value, def.srid ?? DEFAULT_SRID);
    if (point.srid !== (def.srid ?? DEFAULT_SRID)) throw new TypeError(`Point field expects SRID ${def.srid ?? DEFAULT_SRID}; received ${point.srid}`);
    return point;
  }
  return value;
}

/**
 * Check whether TINA4_ORM_PLURAL_TABLE_NAMES is enabled in .env.
 * When true, hasMany relationship keys get an "s" suffix (e.g. "posts" instead of "post").
 */
function _pluralRelKeys(): boolean {
  const v = process.env.TINA4_ORM_PLURAL_TABLE_NAMES ?? "";
  return /^(true|1|yes)$/i.test(v);
}

/**
 * Cross-model FK registry: maps referenced model name → list of has-many specs.
 * Populated by BaseModel._processForeignKeys() when a model with foreignKey fields is used.
 */
const _fkRegistry = new Map<string, Array<{ foreignKey: string; declaringModel: string; hasManyKey: string }>>();

/**
 * REL-EAGER-UNBOUNDED: max parent PKs per eager `WHERE fk IN (...)` query, so a
 * very large parent set never yields an unbounded IN list (a query-size / driver
 * parameter-limit risk). Each chunk is one query.
 */
const EAGER_IN_CHUNK = 500;

/** Split an array into fixed-size chunks. */
function _chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Normalize an eager-load join key so an INTEGER primary key (1) matches a
 * foreign key that round-tripped through the driver as "1.0" / 1.0 (SQLite gives
 * a FK column TEXT/REAL affinity, so `String(1)` and `String("1.0")` would not
 * group together). A genuinely non-numeric key (e.g. a UUID) is left untouched.
 */
function _joinKey(v: unknown): string {
  if (typeof v === "number") return String(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return String(Number(v));
  return String(v);
}

/**
 * BaseModel provides instance methods for ORM models.
 * Models extend this class and define static properties.
 *
 * Usage:
 *   class User extends BaseModel {
 *     static tableName = "users";
 *     static fields = { id: { type: "integer", primaryKey: true, autoIncrement: true }, ... };
 *     static softDelete = true;
 *     static tableFilter = "active = 1";
 *     static hasOne = [{ model: "Profile", foreignKey: "user_id" }];
 *     static hasMany = [{ model: "Post", foreignKey: "author_id" }];
 *     static _db = "secondary";
 *     static fieldMapping = { firstName: "first_name", lastName: "last_name" };
 *     static autoMap = true; // auto-generate fieldMapping from camelCase → snake_case
 *   }
 */

/**
 * The ONE process-wide, tag-aware model query cache shared by EVERY model, so a
 * write on one model busts a cross-table query cached on another (CACHE-DEC-01).
 * Mirrors the Python master's module-level `_query_cache`; it is the existing
 * QueryCache subsystem (TTL + tags) -- zero new deps -- and is separate from the
 * adapter-level auto-cache (CachedDatabaseAdapter), which is env-gated and off by
 * default.
 */
const modelQueryCache = new QueryCache({ defaultTtl: 0, maxSize: 500 });

/** Identifier after a FROM / JOIN keyword (optionally schema-qualified/quoted). */
const CACHE_TABLE_RE =
  /\b(?:FROM|JOIN)\s+([`"[]?[A-Za-z_][\w$]*[`"\]]?(?:\.[`"[]?[A-Za-z_][\w$]*[`"\]]?)?)/gi;

/**
 * Table names a query reads FROM / JOINs -- lowercased, schema-stripped.
 *
 * Best-effort: for each FROM/JOIN keyword it takes the following identifier,
 * drops any quoting (backticks, double quotes, square brackets) and schema
 * prefix (public.users -> users), and ignores the alias. A cached query is
 * tagged with these tables so a write to any one of them invalidates it.
 */
function tablesInSql(sql: string): string[] {
  const tables = new Set<string>();
  for (const match of (sql ?? "").matchAll(CACHE_TABLE_RE)) {
    let name = match[1].replace(/[`"[\]]/g, "");
    if (name.includes(".")) name = name.split(".").pop() ?? name;
    if (name) tables.add(name.toLowerCase());
  }
  return [...tables];
}

export class BaseModel {
  static tableName: string;
  static fields: Record<string, FieldDefinition>;
  static softDelete?: boolean;
  static tableFilter?: string;
  static hasOne?: RelationshipDefinition[];
  static hasMany?: RelationshipDefinition[];
  static belongsTo?: RelationshipDefinition[];
  static _db?: string;

  /**
   * When true, auto-generates fieldMapping entries from camelCase field names
   * to snake_case DB column names. Explicit fieldMapping entries always win.
   */
  static autoMap: boolean = true;

  /**
   * Maps JS property names to database column names.
   * Example: { firstName: "first_name" } means the JS property `firstName`
   * corresponds to the database column `first_name`.
   * Properties not listed here use the property name as-is.
   */
  static fieldMapping: Record<string, string> = {};

  /**
   * When true, auto-generates CRUD routes for this model.
   * Models must explicitly opt-in by setting `static autoCrud = true;`.
   */
  static autoCrud: boolean = false;

  /** Instance data */
  [key: string]: unknown;

  /** Relationship cache for lazy loading */
  private _relCache: Record<string, unknown> = {};

  /**
   * Cause of the most recent failed save(). null when the last save()
   * succeeded. Mirrors db.getError() so a caller that checks
   * `if (!(await model.save()))` can still recover the real cause via
   * `model.getError()` / `model.lastError` — the failure never vanishes
   * silently. Set by save() (validation message or driver error), cleared
   * to null on a successful save.
   */
  lastError: string | null = null;

  constructor(data?: Record<string, unknown> | string) {
    // Accept a JSON object string (parity with Python/PHP/Ruby):
    //   new Widget('{"id":1,"name":"alpha"}')
    if (typeof data === "string") {
      data = JSON.parse(data) as Record<string, unknown>;
    }
    // A single model is one record — reject an array with a clear message
    // (previously an array silently produced an empty model).
    if (Array.isArray(data)) {
      throw new TypeError(
        `${(this.constructor as typeof BaseModel).name} expects an object, keyword data, ` +
          `or a JSON object string for one record — got an array. ` +
          `Map over the list to build many records.`,
      );
    }
    const ModelClass0 = this.constructor as typeof BaseModel;
    // Set defaults from field definitions BEFORE populating from data.
    // Outlier A (mirrors Python issue #50.1): a callable default is resolved
    // to its called value PER INSTANCE, so per-row defaults (e.g.
    // `default: () => new Date()`) actually differ and a function never
    // reaches the driver. Static defaults are assigned verbatim. Data passed
    // to the constructor overrides any default below.
    const fields0 = ModelClass0.fields ?? {};
    for (const [name, def] of Object.entries(fields0)) {
      if (def.default === undefined) continue;
      let dv = typeof def.default === "function"
        ? (def.default as () => unknown)()
        : def.default;
      // Deep-clone a mutable object/array default so two instances never alias
      // the same object (e.g. a json field `default: {}` — mutating a.meta must
      // not leak into b.meta). Parity with the Python master's per-instance
      // deepcopy and Ruby's Marshal round-trip.
      if (def.type === "point" && dv !== null && dv !== undefined) {
        dv = fromDbFieldValue(def, dv);
      } else if (dv !== null && typeof dv === "object") dv = structuredClone(dv);
      this[name] = dv;
    }

    if (data) {
      const ModelClass = this.constructor as typeof BaseModel;
      // If autoMap is on, auto-generate fieldMapping from camelCase fields
      if (ModelClass.autoMap) {
        const fields = ModelClass.fields || {};
        for (const key of Object.keys(fields)) {
          if (!ModelClass.fieldMapping[key]) {
            const snaked = camelToSnake(key);
            if (snaked !== key) {
              ModelClass.fieldMapping[key] = snaked;
            }
          }
        }
      }
      const reverseMapping = ModelClass.getReverseMapping();
      for (const [key, value] of Object.entries(data)) {
        // Lowercase the DB column key so UPPERCASE columns (Firebird/Oracle) match the mapping
        const jsProp = reverseMapping[key] ?? reverseMapping[key.toLowerCase()] ?? key;
        // A json column arrives as a JSON string from the driver (or as a raw
        // string a caller passed); decode it to the object/array the property
        // holds. A value already an object is left as-is.
        this[jsProp] = fromDbFieldValue(fields0[jsProp], value);
      }
    }
  }

  /**
   * Get the database column name for a JS property.
   * Returns the mapped column name, or the property name if no mapping exists.
   */
  static getDbColumn(prop: string): string {
    return this.fieldMapping[prop] ?? prop;
  }

  /**
   * Get all instance data converted to database column names.
   * Uses fieldMapping to translate JS property names to DB column names.
   */
  getDbData(): Record<string, unknown> {
    const ModelClass = this.constructor as typeof BaseModel;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(ModelClass.fields)) {
      if (this[key] !== undefined) {
        const dbCol = ModelClass.getDbColumn(key);
        result[dbCol] = toDbFieldValue(ModelClass.fields[key], this[key]);
      }
    }
    return result;
  }

  /**
   * Get the reverse mapping (DB column → JS property).
   * Flips fieldMapping so that { firstName: "first_name" } becomes { first_name: "firstName" }.
   */
  static getReverseMapping(): Record<string, string> {
    const reverse: Record<string, string> = {};
    for (const [jsProp, dbCol] of Object.entries(this.fieldMapping)) {
      reverse[dbCol] = jsProp;
    }
    return reverse;
  }

  /**
   * Process any foreignKey field definitions on this model, auto-wiring:
   * - belongsTo entries on this model (strip _id from key → association name)
   * - hasMany entries on the referenced model via the module-level _fkRegistry
   *
   * Idempotent — safe to call multiple times.
   */
  static _processForeignKeys(): void {
    const fields = this.fields ?? {};
    for (const [key, def] of Object.entries(fields)) {
      if (def.type !== "foreignKey" || !def.references) continue;

      // Auto-wire belongsTo on this model
      const belongsName = key.endsWith("_id") ? key.slice(0, -3) : key;
      this.belongsTo = this.belongsTo ?? [];
      if (!this.belongsTo.find((r) => r.foreignKey === key)) {
        this.belongsTo.push({ model: def.references, foreignKey: key });
      }

      // Register hasMany on the referenced model via the module-level registry.
      // Outlier F: the has-many key defaults to the DECLARING class name
      // lowercased + "s" (Python master: `name.lower() + "s"`), e.g. a Post
      // with author_id → Author.posts. The relatedName override wins. The old
      // default was the table name, which drifted from the documented rule.
      const hasManyKey = def.relatedName ?? (this.name.toLowerCase() + "s");
      const existing = _fkRegistry.get(def.references) ?? [];
      if (!existing.find((r) => r.foreignKey === key && r.declaringModel === this.name)) {
        existing.push({ foreignKey: key, declaringModel: this.name, hasManyKey });
        _fkRegistry.set(def.references, existing);
      }
    }
  }

  /**
   * Merge any FK-registry-registered hasMany entries for this model.
   * Called before relationship resolution so the referenced model gets its has-many wired.
   */
  static _applyFkRegistry(): void {
    const entries = _fkRegistry.get(this.name) ?? [];
    for (const entry of entries) {
      this.hasMany = this.hasMany ?? [];
      if (!this.hasMany.find((r) => r.foreignKey === entry.foreignKey && r.model === entry.declaringModel)) {
        // Outlier F: carry the derived has-many key (declaring class lowercased
        // + "s", or the relatedName override) onto the relationship so an
        // include: ["posts"] resolves to it — not the related table name.
        this.hasMany.push({ model: entry.declaringModel, foreignKey: entry.foreignKey, relatedName: entry.hasManyKey });
      }
    }
  }

  /**
   * Create a fluent QueryBuilder pre-configured for this model's table and database.
   *
   * Usage:
   *   const results = User.query().where("active = ?", [1]).orderBy("name").get();
   *
   * @returns A QueryBuilder instance bound to this model's table and database.
   */
  static query(): QueryBuilder {
    return QueryBuilder.fromTable(this.tableName, this.getDb(), this.getPkColumn());
  }

  /**
   * Get the database adapter for this model.
   * If no adapter is registered, attempts auto-discovery from TINA4_DATABASE_URL.
   * SQLite URLs are initialised synchronously. Other engines require initDatabase()
   * to be called before first use.
   */
  protected static getDb(): DatabaseAdapter {
    if (this._db) {
      return getNamedAdapter(this._db);
    }
    try {
      return getAdapter();
    } catch {
      // No adapter registered — try TINA4_DATABASE_URL auto-discovery
      const url = process.env.TINA4_DATABASE_URL;
      if (url) {
        const parsed = parseDatabaseUrl(url);
        if (parsed.engine === "sqlite") {
          // SQLite adapter is synchronous — create it inline and register as default
          const dbPath = parsed.database || "./data/tina4.db";
          // Typed as the INTERFACE so the optional identity tag is assignable.
          const adapter: DatabaseAdapter = new SQLiteAdapter(dbPath);
          adapter.cacheIdentity = QueryCache.cacheIdentity(url);
          setAdapter(adapter);
          return adapter;
        }
        throw new Error(
          `TINA4_DATABASE_URL is set to a non-SQLite engine ("${parsed.engine}"). ` +
          `Call await initDatabase() at startup before using ORM models.`,
        );
      }
      throw new Error(
        "No database adapter configured. Call initDatabase() or set TINA4_DATABASE_URL in .env.",
      );
    }
  }

  /**
   * Get the primary key field name (JS property name).
   */
  protected static getPkField(): string {
    return Object.entries(this.fields).find(([, def]) => def.primaryKey)?.[0] ?? "id";
  }

  /**
   * EVERY primary-key field name, in declaration order.
   *
   * A key may span several columns. `getPkField()` returns only the FIRST and
   * is kept for the auto-increment paths, which are single-column by
   * definition. Anything that ADDRESSES a row must use this: keying on one
   * column of a composite key matches every row sharing that value, which is
   * the data-loss shape feature 4 removed from the raw write path below.
   */
  protected static getPkFields(): string[] {
    const keys = Object.entries(this.fields)
      .filter(([, def]) => def.primaryKey)
      .map(([name]) => name);
    return keys.length > 0 ? keys : ["id"];
  }

  /** A WHERE naming EVERY primary-key column, and its bound params. */
  protected pkWhere(): { sql: string; params: unknown[] } {
    const ModelClass = this.constructor as typeof BaseModel;
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const name of ModelClass.getPkFields()) {
      clauses.push(`${ModelClass.getDbColumn(name)} = ?`);
      params.push((this as Record<string, unknown>)[name]);
    }
    return { sql: clauses.join(" AND "), params };
  }

  /**
   * Get the primary key database column name (applies fieldMapping).
   */
  protected static getPkColumn(): string {
    return this.getDbColumn(this.getPkField());
  }

  /**
   * Shared read tail for the collection-returning finders (where / all / select
   * / find filter-form / withTrashed). Runs the SAME two calls `db.fetch()`
   * makes — the page fetch AND the COUNT probe over the SAME base SQL — hydrates
   * the rows into model instances, and returns a ModelCollection carrying the
   * total (ADR-0064).
   *
   * The total is FREE: `probeTotal` is the exact `COUNT(*)` probe `db.fetch()`
   * already runs; the ORM used to discard it. ZERO extra queries beyond that one
   * probe. `sql` MUST NOT carry its own LIMIT/OFFSET — `adapterFetch` applies
   * limit/offset to the page, and the probe wraps the un-limited SQL so it counts
   * the WHOLE filtered set, not the page.
   */
  protected static async _collect<T extends BaseModel>(
    this: typeof BaseModel & (new (data?: Record<string, unknown>) => T),
    sql: string,
    params: unknown[] | undefined,
    limit: number,
    offset: number,
    include?: string[],
  ): Promise<ModelCollection<T>> {
    const db = this.getDb();
    const rows = await adapterFetch(db, sql, params, limit, offset);
    const data: Record<string, unknown>[] = Array.isArray(rows)
      ? (rows as Record<string, unknown>[])
      : ((rows as { data?: Record<string, unknown>[] })?.data ?? []);
    // The total comes from the fetch COUNT probe — NOT data.length (that is only
    // the page). probeTotal returns undefined only for an unbounded read
    // (limit <= 0), where the page IS the whole set, so data.length is right.
    const total = (await probeTotal(db, sql, params, limit)) ?? data.length;
    const instances = data.map((row) => new this(row) as T);
    if (include) {
      await (this as typeof BaseModel)._eagerLoad(instances as BaseModel[], include);
    }
    return new ModelCollection<T>(instances, total, limit, offset);
  }

  /**
   * Find a record by primary key.
   * @param id Primary key value.
   * @param include Optional array of relationship names to eager-load.
   */
  static async findById<T extends BaseModel>(this: new (data?: Record<string, unknown>) => T, id: unknown, include?: string[]): Promise<T | null> {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    const pkCol = ModelClass.getPkColumn();
    let sql = `SELECT * FROM "${ModelClass.tableName}" WHERE "${pkCol}" = ?`;

    if (ModelClass.softDelete) {
      sql += ` AND is_deleted = 0`;
    }
    if (ModelClass.tableFilter) {
      sql += ` AND ${ModelClass.tableFilter}`;
    }

    const instance = await ModelClass.selectOne<T>(sql, [id]);
    if (instance && include) {
      await ModelClass._eagerLoad([instance], include);
    }
    return instance;
  }

  /**
   * Create a new instance from data, save it, and return the saved instance.
   *
   * Canonical #3: if the underlying save() fails (validation errors or a
   * driver error), create() returns `false` — it does NOT hand back a
   * possibly-unsaved instance, so a failed insert can never masquerade as a
   * success. The failure cause is logged and available on the (discarded)
   * instance's getError() via the same path save() uses.
   *
   * Usage:
   *   const user = User.create({ name: "Alice", email: "alice@example.com" });
   *   if (!(await User.create({ name: null }))) { ... }   // save() failed -> false
   */
  static async create<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    data: Record<string, unknown> = {},
  ): Promise<T | false> {
    const instance = new this(data) as T;
    if ((await instance.save()) === false) {
      return false;
    }
    return instance;
  }

  /**
   * Find record(s) by primary key, filter object, or all.
   *
   * Outlier C — overloaded on the first argument (parity with
   * Python/PHP/Ruby):
   *   - number | string (scalar PK) → single instance (or null), like
   *     findById(pk). `include` is accepted as the 2nd argument in this form.
   *   - object (filter)             → array of instances (AND-ed conditions).
   *   - omitted                     → array of all records.
   *
   * Usage:
   *   User.find(1)                       → User | null   (PK lookup)
   *   User.find(1, ["posts"])            → User | null   (PK lookup + eager)
   *   User.find({ name: "Alice" })       → [User, ...]
   *   User.find({ age: 18 }, 10)         → [User, ...]  (limit 10)
   *   User.find({}, 100, 0, "name ASC")  → [User, ...]  (with orderBy)
   *   User.find()                        → all records
   */
  // Scalar PK → single instance | null.
  static async find<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    pk: number | string,
    include?: string[],
  ): Promise<T | null>;
  // Filter object / all → array.
  static async find<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    filter?: Record<string, unknown>,
    limit?: number,
    offset?: number,
    orderBy?: string,
    include?: string[],
  ): Promise<ModelCollection<T>>;
  static async find<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    filter?: Record<string, unknown> | number | string,
    limit: number | string[] = 100,
    offset = 0,
    orderBy?: string,
    include?: string[],
  ): Promise<ModelCollection<T> | T | null> {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);

    // Scalar PK lookup routes to findById. A number or a string (but NOT a
    // boolean, and NOT an object) is a primary-key value — Active Record
    // convention (Django Model.objects.get(pk), SQLAlchemy session.get(M, id),
    // Ruby Model.find(1)). In the scalar form the 2nd arg is `include`.
    if (typeof filter === "number" || typeof filter === "string") {
      const inc = Array.isArray(limit) ? limit : undefined;
      return (ModelClass.findById as (id: unknown, include?: string[]) => Promise<T | null>).call(
        ModelClass, filter, inc,
      );
    }

    // Array form — coerce `limit` back to a number for the list path.
    const lim = typeof limit === "number" ? limit : 100;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter) {
      for (const [key, value] of Object.entries(filter)) {
        const col = ModelClass.getDbColumn(key) ?? key;
        conditions.push(`"${col}" = ?`);
        params.push(value);
      }
    }

    if (ModelClass.softDelete) {
      conditions.push("is_deleted = 0");
    }

    let sql = `SELECT * FROM "${ModelClass.tableName}"`;
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    if (orderBy) {
      sql += ` ORDER BY ${orderBy}`;
    }

    return ModelClass._collect<T>(sql, params, lim, offset, include);
  }

  /**
   * Load a record into this instance via selectOne.
   * Returns true if found and loaded, false otherwise.
   */
  /**
   * Load a record into this instance.
   *
   * Usage:
   *   orm.id = 1; orm.load()          — uses PK already set
   *   orm.load("id = ?", [1])         — filter with params
   *   orm.load("id = 1")              — filter string
   *
   * Returns true if found, false otherwise.
   */
  async load(filter?: string, params?: unknown[], include?: string[]): Promise<boolean> {
    const ModelClass = this.constructor as typeof BaseModel & (new (data?: Record<string, unknown>) => BaseModel);
    const table = (ModelClass as any).tableName ?? (this as any).tableName;

    let sql: string;
    if (filter === undefined || filter === null) {
      // No args — use the PK value already set. Outlier B: resolve the REAL
      // primary key via getPkField()/getPkColumn() (a model has no
      // `primaryKey` static — the old code referenced a non-existent field, so
      // it always queried `WHERE undefined = ?` and never loaded). Use the JS
      // property for the value and the DB column for the WHERE clause.
      const pkProp = ModelClass.getPkField();
      const pkCol = ModelClass.getPkColumn();
      const pkValue = (this as any)[pkProp];
      if (pkValue === undefined || pkValue === null) return false;
      sql = `SELECT * FROM "${table}" WHERE "${pkCol}" = ?`;
      params = [pkValue];
    } else {
      sql = `SELECT * FROM ${table} WHERE ${filter}`;
    }

    const result = await ModelClass.selectOne(sql, params, include);
    if (!result) return false;
    const data = (result as any).toJSON ? (result as any).toJSON() : result;
    for (const [key, value] of Object.entries(data)) {
      (this as any)[key] = value;
    }
    return true;
  }

  /**
   * Find all records.
   *
   * BREAKING (3.13.95, parity): the signature is now
   * `all(limit?, offset?, include?, orderBy?)`. It NO LONGER accepts leading
   * `where`/`params`.
   *
   * Node was the sole outlier of the four. The master and the other two never
   * had a filter on `all()`:
   *   Python  all(limit=100, offset=0, include=None, order_by=None)
   *   PHP     all(int $limit = 100, int $offset = 0, ?array $include, ?string $orderBy)
   *   Ruby    all(limit: 100, offset: nil, order_by: nil, include: nil)
   * Node's extra leading parameters shifted every argument, so the same
   * positional call meant different things in different languages -- which is
   * precisely what the parity mandate exists to prevent.
   *
   * MIGRATION: a filtered read moves to `where()`, which already exists and
   * takes the conditions first:
   *   before: User.all("age > ?", [28])
   *   after:  User.where("age > ?", [28])
   * TypeScript callers get a compile error (string is not assignable to number),
   * so the break is loud rather than silent.
   *
   * @param limit   Max records (default 100, the shared cross-framework cap).
   * @param offset  Records to skip (default 0).
   * @param include Relationship names to eager-load.
   * @param orderBy ORDER BY clause (e.g. "name ASC").
   */
  static async all<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    limit: number = DEFAULT_ROW_CAP,
    offset: number = 0,
    include?: string[],
    orderBy?: string,
  ): Promise<ModelCollection<T>> {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);

    const conditions: string[] = [];
    if (ModelClass.softDelete) {
      conditions.push("is_deleted = 0");
    }
    if (ModelClass.tableFilter) {
      conditions.push(ModelClass.tableFilter);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const orderClause = orderBy ? ` ORDER BY ${orderBy}` : "";
    // No LIMIT/OFFSET embedded: _collect's adapterFetch applies them to the page
    // and the COUNT probe wraps the un-limited SQL so the total is the whole set.
    const sql = `SELECT * FROM "${ModelClass.tableName}"${whereClause}${orderClause}`;

    // No bind parameters: the only conditions left are the framework's own
    // softDelete / tableFilter literals. A caller-supplied filter belongs on
    // where(), which binds its params properly.
    return ModelClass._collect<T>(sql, [], limit, offset, include);
  }

  /**
   * Query records with a WHERE clause.
   * Matches Python/PHP/Ruby where() API.
   *
   * @param conditions WHERE clause (e.g. "age > ? AND active = ?")
   * @param params     Bind parameters
   * @param limit      Max records (default 100)
   * @param offset     Skip records (default 0)
   * @param include    Relationship names to eager-load
   * @param orderBy    ORDER BY clause (e.g. "name ASC")
   */
  static async where<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    conditions: string,
    params?: unknown[],
    limit: number = DEFAULT_ROW_CAP,
    offset: number = 0,
    include?: string[],
    orderBy?: string,
  ): Promise<ModelCollection<T>> {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);

    const parts: string[] = [];
    if (ModelClass.softDelete) {
      parts.push("is_deleted = 0");
    }
    if (ModelClass.tableFilter) {
      parts.push(ModelClass.tableFilter);
    }
    parts.push(`(${conditions})`);

    const orderClause = orderBy ? ` ORDER BY ${orderBy}` : "";
    // No LIMIT/OFFSET embedded — _collect applies them to the page and probes
    // the total (ADR-0064). orderBy affects the page only; COUNT is order-free.
    const sql = `SELECT * FROM "${ModelClass.tableName}" WHERE ${parts.join(" AND ")}${orderClause}`;

    return ModelClass._collect<T>(sql, params, limit, offset, include);
  }

  /**
   * Save this instance (insert or update). Returns this on success (fluent
   * self), false on failure.
   *
   * Fails loud, never silent (the same principle db.execute() follows by
   * raising). On ANY failure path save() returns `false` — keeping the
   * contract callers rely on (`if (!(await model.save())) ...`) — but it also
   * (a) logs the real cause via Log.error with model/table context and
   * (b) records the cause on `this.lastError` so a caller can recover it after
   * the fact via getError() / lastError. It never throws and never changes the
   * `this | false` return shape.
   *
   * Two distinct failure paths, both loud:
   *  - Validation (canonical #2): validate() runs FIRST. If it returns errors,
   *    save() logs them, records them on lastError, and returns false WITHOUT
   *    touching the database — an invalid model never reaches the driver.
   *  - Database: a driver error (NOT NULL, duplicate PK, missing table, ...) is
   *    rolled back, logged with the underlying cause, recorded on lastError,
   *    and returns false — the cause is no longer swallowed silently.
   */
  async save(): Promise<this | false> {
    const ModelClass = this.constructor as typeof BaseModel;

    const db = ModelClass.getDb();
    const pk = primaryKeyFields(ModelClass)[0];
    const pkCol = ModelClass.getDbColumn(pk);
    const pkValue = this[pk];
    const pkField = (ModelClass.fields as Record<string, FieldDefinition>)[pk];
    this._relCache = {}; // Clear relationship cache on save

    const isUpdate = await resolveSaveMode(this, ModelClass, db, pk, pkValue, pkField);
    if (!validateBeforeSave(this, ModelClass, isUpdate)) return false;

    await adapterStartTransaction(db);
    try {
      if (isUpdate) {
        await executeModelUpdate(this, ModelClass, db);
      } else {
        await executeModelInsert(this, ModelClass, db, pk, pkCol, pkField);
      }
      await adapterCommit(db);
    } catch (e: unknown) {
      await adapterRollback(db);
      return saveDatabaseFailure(this, ModelClass, db, e);
    }
    // Success — clear any previously-recorded error.
    this.lastError = null;
    // Bust cached reads of any table this write touched (CACHE-DEC-01).
    ModelClass.clearCache();
    return this;
  }

  /**
   * Return the cause of the most recent failed save(), or null.
   *
   * Mirrors db.getError(). After save() returns false — whether from
   * validation or a driver error — the real cause is retrievable here (and on
   * this.lastError) so a caller using the `if (!(await model.save()))`
   * contract can still surface it. Cleared to null on a successful save.
   */
  getError(): string | null {
    return this.lastError;
  }

  /**
   * Delete this instance. Uses soft delete if configured.
   */
  async delete(): Promise<boolean> {
    const ModelClass = this.constructor as typeof BaseModel;
    const db = ModelClass.getDb();
    const pk = ModelClass.getPkField();
    const pkValue = this[pk];

    if (pkValue === undefined || pkValue === null) {
      throw new Error("Cannot delete a model without a primary key value");
    }

    await adapterStartTransaction(db);
    try {
      if (ModelClass.softDelete) {
        await adapterExecute(db,
          `UPDATE "${ModelClass.tableName}" SET is_deleted = 1 WHERE ${this.pkWhere().sql}`,
          this.pkWhere().params,
        );
        this.is_deleted = 1;
      } else {
        await adapterExecute(db,
          `DELETE FROM "${ModelClass.tableName}" WHERE ${this.pkWhere().sql}`,
          this.pkWhere().params,
        );
      }
      await adapterCommit(db);
    } catch (e) {
      await adapterRollback(db);
      throw e;
    }
    // Bust cached reads of any table this write touched (CACHE-DEC-01).
    ModelClass.clearCache();
    return true;
  }

  /**
   * Convert to plain object (dictionary).
   * @param include Optional array of relationship names to include (supports dot notation for nesting).
   * @param case_ Key casing: 'camel' (default, keys as-is) or 'snake' (convert via fieldMapping).
   */
  toDict(include?: string[], case_: "camel" | "snake" = "camel"): Record<string, unknown> {
    const ModelClass = this.constructor as typeof BaseModel;
    const result = serializeModelFields(this, ModelClass, case_);
    if (include) serializeIncludedRelations(this, ModelClass, result, include, case_);
    else serializeLoadedRelations(this, ModelClass, result);
    return result;
  }

  toFeature(geometryField?: string, include?: string[]): Record<string, unknown> {
    const ModelClass = this.constructor as typeof BaseModel;
    const pointFields = Object.entries(ModelClass.fields).filter(([, def]) => def.type === "point").map(([name]) => name);
    const field = geometryField ?? pointFields[0];
    if (!field || !pointFields.includes(field)) throw new Error("toFeature() needs a declared point field");
    const properties = this.toDict(include, "camel");
    const geometry = properties[field] ?? null;
    delete properties[field];
    return { type: "Feature", geometry, properties };
  }

  static featureCollection(models: BaseModel[], geometryField?: string, include?: string[]): Record<string, unknown> {
    return { type: "FeatureCollection", features: models.map((model) => model.toFeature(geometryField, include)) };
  }

  /**
   * Convert to an associative object (alias for toDict).
   */
  toAssoc(include?: string[], case_: "camel" | "snake" = "camel"): Record<string, unknown> {
    return this.toDict(include, case_);
  }

  /**
   * Convert to a plain object (alias for toDict).
   */
  toObject(case_: "camel" | "snake" = "camel"): Record<string, unknown> {
    return this.toDict(undefined, case_);
  }

  /**
   * Convert to an array of values.
   */
  toArray(): unknown[] {
    return Object.values(this.toDict());
  }

  /**
   * Convert to a list (alias for toArray).
   */
  toList(): unknown[] {
    return this.toArray();
  }

  /**
   * Convert to JSON string.
   * @param include Optional relationship names to include.
   */
  toJson(include?: string[], case_: "camel" | "snake" = "camel"): string {
    return JSON.stringify(this.toDict(include, case_));
  }

  /**
   * Validate this instance's values against the model's field definitions.
   * Returns an array of error strings (empty array means valid).
   */
  validate(isUpdate = false): string[] {
    const ModelClass = this.constructor as typeof BaseModel;
    const data: Record<string, unknown> = {};
    for (const name of Object.keys(ModelClass.fields)) {
      data[name] = this[name];
    }
    // isUpdate wires the partial-update mode: on an update a field that is not
    // provided is not spuriously "required" (see validateFields). Field values
    // that ARE present stay held to their type/length/pattern/range rules.
    const errors = validateFields(data, ModelClass.fields, isUpdate);
    return errors.map((e) => `${e.field} ${e.message}`);
  }

  /**
   * Generate and execute CREATE TABLE DDL from the model's field definitions.
   * Uses the adapter's createTable method if available, otherwise builds SQL directly.
   */
  static async createTable(): Promise<boolean> {
    const db = this.getDb();
    const pointFields = Object.entries(this.fields).filter(([, def]) => def.type === "point");
    const engine = db.getDatabaseType();
    if (pointFields.length > 0) SQLTranslator.requireSpatial(engine, "PointField");
    if (await adapterTableExists(db, this.tableName)) return this.createSpatialIndexes(db, pointFields);

    if (hasAdapterCreateTable(db)) {
      const mappedFields = mappedCreateTableFields(this);
      addSoftDeleteField(this, mappedFields);
      await adapterCreateTable(db, this.tableName, mappedFields);
      return this.createSpatialIndexes(db, pointFields);
    }

    // Fallback: build SQL manually (SQLite-only dialect — used only when an
    // adapter lacks createTable, which none currently do).
    await createFallbackTable(db, this);
    return true;
  }

  private static async createSpatialIndexes(db: DatabaseAdapter, fields: Array<[string, FieldDefinition]>): Promise<boolean> {
    for (const [fieldName, def] of fields) {
      SQLTranslator.pointColumnType(db.getDatabaseType(), def.srid ?? DEFAULT_SRID);
      if (def.spatialIndex === false) continue;
      await adapterExecute(db, SQLTranslator.spatialIndex(db.getDatabaseType(), this.tableName, this.getDbColumn(fieldName)));
    }
    return true;
  }

  /**
   * Find a record by primary key or throw an error if not found.
   */
  static async findOrFail<T extends BaseModel>(this: new (data?: Record<string, unknown>) => T, id: unknown): Promise<T> {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    const result = (await ModelClass.findById(id)) as T | null;
    if (result === null) {
      throw new Error(`${ModelClass.tableName}: record with id ${id} not found`);
    }
    return result;
  }

  /**
   * Return true if a record with the given primary key exists.
   */
  static async exists(pkValue: unknown): Promise<boolean> {
    const ModelClass = this as unknown as typeof BaseModel;
    return (await ModelClass.findById(pkValue)) !== null;
  }

  /**
   * Every table a cached query touches: this model's table plus every FROM/JOIN
   * table in `sql`. A write to any of these busts the entry (CACHE-DEC-01).
   */
  static _cacheTags(sql: string): string[] {
    const ModelClass = this as unknown as typeof BaseModel;
    const tags = [(ModelClass.tableName ?? "").toLowerCase()];
    for (const table of tablesInSql(sql)) {
      if (!tags.includes(table)) tags.push(table);
    }
    return tags;
  }

  /**
   * Run a raw SQL query with results cached by TTL.
   *
   * Invalidation (CACHE-DEC-01): the entry is tagged by every table the query
   * touches (this model's table plus any FROM/JOIN tables) in ONE process-wide
   * shared cache, so a write through the ORM (save/delete/forceDelete/restore)
   * to ANY of those tables busts it -- including a cross-table JOIN cached on a
   * different model. `ttl <= 0` means NO-CACHE: the query runs and the rows are
   * returned but nothing is stored, so every read hits the database.
   *
   * @param sql     SQL query string.
   * @param params  Bind parameters.
   * @param ttl     Cache TTL in seconds (default 60; <= 0 = no-cache).
   * @param limit   Max records to return (default 100).
   * @param offset  Records to skip (default 0).
   * @param include Relationship names to eager-load on cache miss.
   */
  static async cached<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    sql: string,
    params?: unknown[],
    ttl = 60,
    limit = DEFAULT_ROW_CAP,
    offset = 0,
    include?: string[],
  ): Promise<T[]> {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    const db = ModelClass.getDb();

    const runQuery = async (): Promise<T[]> => {
      const querySql = `${sql} LIMIT ${limit} OFFSET ${offset}`;
      const rows = await adapterQuery(db, querySql, params);
      const results = rows.map((row) => new ModelClass(row as Record<string, unknown>) as T);
      if (include && results.length > 0) {
        await ModelClass._eagerLoad(results as BaseModel[], include);
      }
      return results;
    };

    // ttl <= 0 is NO-CACHE: run it live, store nothing, read nothing.
    if (ttl <= 0) return runQuery();

    const cacheKey = `${ModelClass.tableName}:${sql}:${limit}:${offset}`;
    const key = QueryCache.queryKey(cacheKey, params ?? [], (db as unknown as { cacheIdentity?: string }).cacheIdentity ?? "");
    const hit = modelQueryCache.get<T[]>(key);
    if (hit !== undefined) return hit;

    const results = await runQuery();
    modelQueryCache.set(key, results, ttl, ModelClass._cacheTags(sql));
    return results;
  }

  /**
   * Invalidate every cached query that touches this model's table.
   *
   * Tag-scoped in the ORM layer (a cached JOIN on another model that reads
   * this table is busted too because it carries this table's tag; a query
   * that never touches this table is left intact), then cascaded to the
   * DB layer on this model's bound connection so an out-of-band write /
   * deliberate refresh / race-with-another-process cannot leave stale rows
   * in db.fetch()'s persistent cache. Called after every ORM write
   * (save/delete/forceDelete/restore) so a read-after-write never serves
   * a stale/deleted row (CACHE-DEC-01). PY-06-22 (3.13.105) added the
   * DB-layer cascade -- previously the two cache layers disagreed under
   * TINA4_AUTO_CACHING=true + TINA4_DB_CACHE=true.
   */
  static clearCache(): void {
    const ModelClass = this as unknown as typeof BaseModel;
    modelQueryCache.clearTag((ModelClass.tableName ?? "").toLowerCase());
    try {
      const db: any = ModelClass.getDb();
      if (typeof db?.cacheClear === "function") db.cacheClear();
    } catch {
      // A resolvable DB is not guaranteed at every clearCache() call site
      // (module-import time in odd bootstraps, tests that mutate bindings);
      // never let a cache-clear crash a save/delete.
    }
  }

  /**
   * Execute a raw SQL SELECT and return results as model instances.
   */
  static async select<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    sql: string,
    params?: unknown[],
    limit: number = DEFAULT_ROW_CAP,
    offset: number = 0,
  ): Promise<ModelCollection<T>> {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    // _collect runs the page fetch — the adapter applies limit/offset via
    // SQLTranslator.appendLimit, which scrubs literals/comments and skips when
    // the caller's SQL already carries its own LIMIT (a second one is a syntax
    // error on every engine) — AND the COUNT probe over the raw SQL, so the
    // ModelCollection carries the total for the filter (ADR-0064).
    return ModelClass._collect<T>(sql, params, limit, offset);
  }

  static async selectOne<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    sql: string,
    params?: unknown[],
    include?: string[],
  ): Promise<T | null> {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    const results = await ModelClass.select<T>(sql, params);
    const instance = results[0] ?? null;
    if (instance && include) {
      await ModelClass._eagerLoad([instance], include);
    }
    return instance;
  }

  /**
   * Permanently delete this instance, bypassing soft delete.
   */
  async forceDelete(): Promise<boolean> {
    const ModelClass = this.constructor as typeof BaseModel;
    const db = ModelClass.getDb();
    const pk = ModelClass.getPkField();
    const pkValue = this[pk];

    if (pkValue === undefined || pkValue === null) {
      throw new Error("Cannot delete a model without a primary key value");
    }

    await adapterStartTransaction(db);
    try {
      await adapterExecute(db,
        `DELETE FROM "${ModelClass.tableName}" WHERE ${this.pkWhere().sql}`,
        this.pkWhere().params,
      );
      await adapterCommit(db);
    } catch (e) {
      await adapterRollback(db);
      throw e;
    }
    // Bust cached reads of any table this write touched (CACHE-DEC-01).
    ModelClass.clearCache();
    return true;
  }

  /**
   * Restore a soft-deleted record.
   */
  async restore(): Promise<boolean> {
    const ModelClass = this.constructor as typeof BaseModel;
    if (!ModelClass.softDelete) {
      throw new Error("restore() is only available on models with softDelete enabled");
    }

    const db = ModelClass.getDb();
    const pk = ModelClass.getPkField();
    const pkValue = this[pk];

    if (pkValue === undefined || pkValue === null) {
      throw new Error("Cannot restore a model without a primary key value");
    }

    await adapterStartTransaction(db);
    try {
      await adapterExecute(db,
        `UPDATE "${ModelClass.tableName}" SET is_deleted = 0 WHERE ${this.pkWhere().sql}`,
        this.pkWhere().params,
      );
      await adapterCommit(db);
    } catch (e) {
      await adapterRollback(db);
      throw e;
    }
    this.is_deleted = 0;
    // Bust cached reads of any table this write touched (CACHE-DEC-01).
    ModelClass.clearCache();
    return true;
  }

  /**
   * Find records including soft-deleted ones.
   */
  static async withTrashed<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    conditions?: string,
    params?: unknown[],
    limit: number = DEFAULT_ROW_CAP,
    offset: number = 0,
  ): Promise<ModelCollection<T>> {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);

    const parts: string[] = [];
    if (ModelClass.tableFilter) {
      parts.push(ModelClass.tableFilter);
    }
    if (conditions) {
      parts.push(conditions);
    }

    let sql = `SELECT * FROM "${ModelClass.tableName}"`;
    if (parts.length > 0) {
      sql += ` WHERE ${parts.join(" AND ")}`;
    }

    // No LIMIT/OFFSET embedded — _collect applies them to the page and probes
    // the total. No is_deleted filter here, so soft-deleted rows are INCLUDED in
    // both the page and the total (ADR-0064).
    return ModelClass._collect<T>(sql, params, limit, offset);
  }

  /**
   * Count records matching conditions (respects soft delete and table filter).
   */
  static async count(conditions?: string, params?: unknown[]): Promise<number> {
    const db = this.getDb();
    const parts: string[] = [];
    if (this.softDelete) {
      parts.push("is_deleted = 0");
    }
    if (this.tableFilter) {
      parts.push(this.tableFilter);
    }
    if (conditions) {
      parts.push(conditions);
    }
    const whereClause = parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "";
    const sql = `SELECT COUNT(*) as cnt FROM "${this.tableName}"${whereClause}`;
    const rows = await adapterQuery(db, sql, params);
    if (rows.length === 0) return 0;
    // PostgreSQL returns COUNT(*) as a bigint, which the `pg` driver hands
    // back as a string ("2"); Firebird upper-cases the alias. Coerce to a
    // Number and tolerate case so count() returns a real number on every engine.
    const row = rows[0] as Record<string, unknown>;
    const cnt = row.cnt ?? row.CNT ?? 0;
    return Number(cnt);
  }

  /**
   * Register a reusable query scope on the class.
   *
   * Usage:
   *   User.scope("active", "active = ?", [1]);
   *   const users = (User as any).active();          // calls where("active = ?", [1])
   *   const users = (User as any).active(10, 5);     // with limit/offset
   */
  static scope(
    name: string,
    filterSql: string,
    params?: unknown[],
  ): void {
    const ModelClass = this as unknown as typeof BaseModel;
    (ModelClass as any)[name] = (limit: number = DEFAULT_ROW_CAP, offset: number = 0) => {
      return ModelClass.where.call(ModelClass as any, filterSql, params, limit, offset);
    };
  }

  /**
   * Load a has-one related model instance.
   */
  async hasOne<T extends BaseModel, R extends BaseModel>(
    this: T,
    relatedClass: typeof BaseModel & (new (data?: Record<string, unknown>) => R),
    foreignKey: string,
  ): Promise<R | null> {
    const ModelClass = this.constructor as typeof BaseModel;
    const pk = ModelClass.getPkField();
    const pkValue = this[pk];

    if (pkValue === undefined || pkValue === null) {
      return null;
    }

    const db = relatedClass.getDb();
    let sql = `SELECT * FROM "${relatedClass.tableName}" WHERE "${foreignKey}" = ?`;
    if (relatedClass.softDelete) {
      sql += ` AND is_deleted = 0`;
    }
    sql += ` LIMIT 1`;

    const rows = await adapterQuery(db, sql, [pkValue]);
    if (rows.length === 0) return null;

    const related = new relatedClass(rows[0] as Record<string, unknown>) as R;
    const relKey = relatedClass.tableName.toLowerCase();
    // Write through the BaseModel index signature: a generic `T` cannot be
    // indexed for writing (TS2862), but `T extends BaseModel` guarantees `this`
    // is a BaseModel, whose `[key: string]: unknown` signature is writable.
    (this as BaseModel)[relKey] = related;
    // IMPREL-NODE-ORPHAN: also store under the serializer's key so an
    // imperatively-loaded relation is included by toDict([relKey]) -- toDict
    // reads _relCache, which the imperative path never populated before, so an
    // imperatively-loaded relation was orphaned from serialization.
    (this as BaseModel)._relCache[relKey] = related;
    return related;
  }

  /**
   * Load has-many related model instances.
   *
   * With no explicit `limit` this returns the WHOLE set (paged internally, like
   * the lazy accessor), never a silent row cap -- so an imperatively-loaded
   * has_many yields the SAME row count as the lazy path. An explicit `limit`
   * still pages.
   */
  async hasMany<T extends BaseModel, R extends BaseModel>(
    this: T,
    relatedClass: typeof BaseModel & (new (data?: Record<string, unknown>) => R),
    foreignKey: string,
    limit?: number,
    offset: number = 0,
  ): Promise<R[]> {
    const ModelClass = this.constructor as typeof BaseModel;
    const pk = ModelClass.getPkField();
    const pkValue = this[pk];

    if (pkValue === undefined || pkValue === null) {
      return [];
    }

    const db = relatedClass.getDb();
    const orderCol = relatedClass.getPkColumn();
    let sql = `SELECT * FROM "${relatedClass.tableName}" WHERE "${foreignKey}" = ?`;
    if (relatedClass.softDelete) {
      sql += ` AND is_deleted = 0`;
    }
    // Order by the child PK for a stable read (parity with the lazy accessor).
    sql += ` ORDER BY "${orderCol}"`;
    // IMPREL-PY-CAP parity: with no explicit limit, return the WHOLE set (like
    // the lazy accessor, which is uncapped) instead of a silent 100-row cap. An
    // explicit limit still pages (explicit, never silent).
    if (limit !== undefined) {
      sql += ` LIMIT ${limit} OFFSET ${offset}`;
    }

    const rows = await adapterQuery(db, sql, [pkValue]);
    const related = rows.map((row) => new relatedClass(row as Record<string, unknown>) as R);
    const relKey = relatedClass.tableName.toLowerCase();
    // See hasOne: write through BaseModel's writable index signature (TS2862).
    (this as BaseModel)[relKey] = related;
    // IMPREL-NODE-ORPHAN: store under the serializer's key so an imperatively
    // loaded relation is included by toDict([relKey]) (was orphaned).
    (this as BaseModel)._relCache[relKey] = related;
    return related;
  }

  /**
   * Load the parent model this instance belongs to.
   */
  async belongsTo<T extends BaseModel, R extends BaseModel>(
    this: T,
    relatedClass: typeof BaseModel & (new (data?: Record<string, unknown>) => R),
    foreignKey: string,
  ): Promise<R | null> {
    // foreignKey is a DB column name — resolve to JS property name on this model
    const ModelClass = this.constructor as typeof BaseModel;
    const reverseMap = ModelClass.getReverseMapping();
    const fkProp = reverseMap[foreignKey] ?? foreignKey;
    const fkValue = this[fkProp];

    if (fkValue === undefined || fkValue === null) {
      return null;
    }

    const db = relatedClass.getDb();
    const relatedPkCol = relatedClass.getPkColumn();
    let sql = `SELECT * FROM "${relatedClass.tableName}" WHERE "${relatedPkCol}" = ?`;
    if (relatedClass.softDelete) {
      sql += ` AND is_deleted = 0`;
    }
    sql += ` LIMIT 1`;

    const rows = await adapterQuery(db, sql, [fkValue]);
    if (rows.length === 0) return null;

    const related = new relatedClass(rows[0] as Record<string, unknown>) as R;
    const relKey = relatedClass.tableName.toLowerCase();
    // See hasOne: write through BaseModel's writable index signature (TS2862).
    (this as BaseModel)[relKey] = related;
    // IMPREL-NODE-ORPHAN: store under the serializer's key so an imperatively
    // loaded relation is included by toDict([relKey]) (was orphaned).
    (this as BaseModel)._relCache[relKey] = related;
    return related;
  }

  /**
   * Register a model class for lookup by name (used by eager loading).
   */
  static _modelRegistry: Record<string, typeof BaseModel> = {};

  static registerModel(name: string, modelClass: typeof BaseModel): void {
    BaseModel._modelRegistry[name] = modelClass;
    // Wire every registered model's FK relationships AND lazy accessors now that
    // a new model is known. A parent's has-many is declared by the CHILD's
    // foreignKey field, so re-wiring all registered models on each registration
    // makes BOTH sides functional (belongsTo + has-many) with lazy accessors,
    // without depending on server-boot auto-discovery. Idempotent.
    BaseModel._processAllForeignKeys();
  }

  /**
   * Process foreignKey fields on every registered model so the cross-model
   * _fkRegistry (and each model's belongsTo/hasMany) is fully wired regardless
   * of which model was used first, then attach the lazy relationship accessors.
   * Idempotent — every step guards against duplicates.
   */
  private static _processAllForeignKeys(): void {
    for (const modelClass of Object.values(BaseModel._modelRegistry)) {
      modelClass._processForeignKeys();
    }
    for (const modelClass of Object.values(BaseModel._modelRegistry)) {
      modelClass._applyFkRegistry();
    }
    // REL-NODE-AUTOWIRE-DEAD: attach lazy accessors (post.author / author.posts)
    // on both sides so DECLARATIVE relationships actually function — matching the
    // imperative belongsTo()/hasMany() path and Python/PHP/Ruby.
    for (const modelClass of Object.values(BaseModel._modelRegistry)) {
      modelClass._wireRelationshipAccessors();
    }
  }

  /**
   * REL-NODE-AUTOWIRE-DEAD: attach a lazy-loading accessor for each declared
   * relationship (belongsTo/hasOne/hasMany) on this model's prototype, so
   * `post.author` / `author.posts` resolve on attribute access. The accessor is
   * async (Node lazy load) and caches into `_relCache` — the SAME cache eager
   * loading fills, so `toDict` stays consistent once a relation has been loaded.
   * Reuses the imperative belongsTo()/hasOne() path and the cross-model registry;
   * a soft-deleted child is excluded and the has-many read is uncapped.
   */
  static _wireRelationshipAccessors(): void {
    const proto = this.prototype as Record<string, unknown>;
    const fields = this.fields ?? {};

    const define = (
      name: string,
      rel: RelationshipDefinition,
      kind: "belongsTo" | "hasOne" | "hasMany",
    ): void => {
      // Never shadow a declared column or an existing member (method / prior
      // accessor). `name in proto` also makes re-wiring idempotent.
      if (!name || name in fields || name in proto) return;
      Object.defineProperty(proto, name, {
        configurable: true,
        enumerable: false,
        get(this: Record<string, unknown>) {
          const cache = this._relCache as Record<string, unknown>;
          if (name in cache) return cache[name]; // eager or prior-lazy value
          const pending = (this._relPromises ??= {}) as Record<string, unknown>;
          if (name in pending) return pending[name]; // in-flight dedupe
          const promise = (async () => {
            const related = BaseModel._modelRegistry[rel.model];
            let value: unknown;
            if (!related) {
              value = kind === "hasMany" ? [] : null;
            } else if (kind === "belongsTo") {
              value = await (this as unknown as BaseModel).belongsTo(related as never, rel.foreignKey);
            } else if (kind === "hasOne") {
              value = await (this as unknown as BaseModel).hasOne(related as never, rel.foreignKey);
            } else {
              value = await BaseModel._loadHasManyLazy(this as unknown as BaseModel, related, rel.foreignKey);
            }
            cache[name] = value;
            delete pending[name];
            return value;
          })();
          pending[name] = promise;
          return promise;
        },
      });
    };

    for (const rel of this.belongsTo ?? []) {
      const name = rel.relatedName
        ?? (rel.foreignKey.endsWith("_id") ? rel.foreignKey.slice(0, -3) : rel.foreignKey);
      define(name, rel, "belongsTo");
    }
    for (const rel of this.hasOne ?? []) {
      define(rel.relatedName ?? rel.model.toLowerCase(), rel, "hasOne");
    }
    for (const rel of this.hasMany ?? []) {
      define(rel.relatedName ?? (rel.model.toLowerCase() + "s"), rel, "hasMany");
    }
  }

  /**
   * Lazy has-many read for a relationship accessor: excludes soft-deleted
   * children and returns the WHOLE set (adapterQuery is uncapped, so the tail is
   * never lost). Ordered by the child PK for a stable read.
   */
  private static async _loadHasManyLazy(
    inst: BaseModel,
    relatedClass: typeof BaseModel,
    foreignKey: string,
  ): Promise<BaseModel[]> {
    const ModelClass = inst.constructor as typeof BaseModel;
    const pk = ModelClass.getPkField();
    const pkValue = (inst as Record<string, unknown>)[pk];
    if (pkValue === undefined || pkValue === null) return [];
    const db = relatedClass.getDb();
    const orderCol = relatedClass.getPkColumn();
    let sql = `SELECT * FROM "${relatedClass.tableName}" WHERE "${foreignKey}" = ?`;
    if (relatedClass.softDelete) sql += ` AND is_deleted = 0`;
    sql += ` ORDER BY "${orderCol}"`;
    const rows = await adapterQuery(db, sql, [pkValue]);
    return rows.map((row) => new (relatedClass as unknown as new (d: Record<string, unknown>) => BaseModel)(row as Record<string, unknown>));
  }

  /**
   * Resolve a model class by name from the registry.
   */
  private static _resolveModel(name: string): (typeof BaseModel) | null {
    return BaseModel._modelRegistry[name] ?? null;
  }

  /**
   * Eager load relationships for a collection of instances (prevents N+1).
   * @param instances Array of model instances.
   * @param include Array of relationship names (supports dot notation for nesting).
   */
  static async _eagerLoad(instances: BaseModel[], include: string[]): Promise<void> {
    if (instances.length === 0) return;

    const ModelClass = instances[0].constructor as typeof BaseModel;

    // Wire FK relationships across ALL registered models, not just the parent.
    // A parent's hasMany is declared by the CHILD's foreignKey field, so we must
    // process every registered model's FKs before resolving includes — otherwise
    // a standalone Author.findById(id, ["posts"]) silently finds nothing because
    // Post._processForeignKeys() never ran. _applyFkRegistry() then merges the
    // registered hasMany entries onto each model.
    BaseModel._processAllForeignKeys();
    const topLevel = groupIncludedRelations(include);
    for (const [relName, nested] of Object.entries(topLevel)) {
      await eagerLoadRelation(instances, ModelClass, relName, nested);
    }
  }

  /**
   * Public alias for _eagerLoad. Eagerly loads relationships for a list of instances,
   * preventing N+1 queries.
   *
   * Usage:
   *   const users = User.all();
   *   await User.eagerLoad(users, ["posts", "profile"]);
   *
   * @param instances  Array of model instances to load relationships onto.
   * @param includeList Array of relationship names (supports dot notation for nesting).
   */
  static async eagerLoad(instances: BaseModel[], includeList: string[]): Promise<void> {
    const ModelClass = this as unknown as typeof BaseModel;
    await ModelClass._eagerLoad(instances, includeList);
  }

  /**
   * Clear the relationship cache.
   */
  clearRelCache(): void {
    this._relCache = {};
  }
}

function savePrimaryKeyWhere(instance: BaseModel, model: typeof BaseModel): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses = primaryKeyFields(model).map((field) => {
    params.push(instance[field]);
    return `${model.getDbColumn(field)} = ?`;
  });
  return { sql: clauses.join(" AND "), params };
}

async function resolveSaveMode(
  instance: BaseModel,
  model: typeof BaseModel,
  db: DatabaseAdapter,
  pk: string,
  pkValue: unknown,
  pkField: FieldDefinition | undefined,
): Promise<boolean> {
  if (pkValue === undefined || pkValue === null || pkField?.autoIncrement) return pkValue !== undefined && pkValue !== null;
  try {
    const where = savePrimaryKeyWhere(instance, model);
    if (primaryKeyFields(model).length > 1) {
      const found = await db.fetch(`SELECT 1 AS present FROM ${model.tableName} WHERE ${where.sql}`, where.params, 1);
      return (found as unknown as { length: number }).length > 0;
    }
    return await model.exists(pkValue);
  } catch {
    return false;
  }
}

function validateBeforeSave(instance: BaseModel, model: typeof BaseModel, isUpdate: boolean): boolean {
  const errors = instance.validate(isUpdate);
  if (errors.length === 0) return true;
  instance.lastError = errors.join("; ");
  Log.error(`${model.name}.save() refused: validation failed for table '${model.tableName}' — ${instance.lastError}`);
  return false;
}

async function executeModelUpdate(instance: BaseModel, model: typeof BaseModel, db: DatabaseAdapter): Promise<void> {
  const fields = Object.entries(model.fields).filter(([name, def]) => !def.primaryKey && instance[name] !== undefined);
  if (fields.length === 0) return;
  const setClause = fields.map(([name]) => `"${model.getDbColumn(name)}" = ?`).join(", ");
  const values = fields.map(([name, def]) => toDbFieldValue(def, instance[name]));
  const where = savePrimaryKeyWhere(instance, model);
  values.push(...where.params);
  await adapterExecute(db, `UPDATE "${model.tableName}" SET ${setClause} WHERE ${where.sql}`, values);
}

function buildInsertStatement(
  instance: BaseModel,
  model: typeof BaseModel,
  db: DatabaseAdapter,
  pkField: FieldDefinition | undefined,
  pkCol: string,
): { sql: string; values: unknown[] } {
  const fields = Object.entries(model.fields).filter(
    ([name, def]) => !(def.primaryKey && def.autoIncrement) && instance[name] !== undefined,
  );
  const returning = pkField?.autoIncrement && db.constructor.name !== "SQLiteAdapter" ? ` RETURNING "${pkCol}"` : "";
  if (fields.length === 0) {
    const emptyInsert = db.constructor.name === "MysqlAdapter"
      ? `INSERT INTO "${model.tableName}" () VALUES ()`
      : `INSERT INTO "${model.tableName}" DEFAULT VALUES`;
    return { sql: emptyInsert + returning, values: [] };
  }
  const columns = fields.map(([name]) => `"${model.getDbColumn(name)}"`).join(", ");
  const placeholders = fields.map(() => "?").join(", ");
  const values = fields.map(([name, def]) => toDbFieldValue(def, instance[name]));
  return { sql: `INSERT INTO "${model.tableName}" (${columns}) VALUES (${placeholders})${returning}`, values };
}

function applyInsertedId(
  instance: BaseModel,
  db: DatabaseAdapter,
  result: unknown,
  pk: string,
  pkCol: string,
): void {
  let newId: number | bigint | string | null = extractLastInsertId(result);
  if (newId === null && result && typeof result === "object") {
    const rows = (result as { rows?: Array<Record<string, unknown>> }).rows;
    if (Array.isArray(rows) && rows[0]) newId = (rows[0][pkCol] ?? rows[0].id ?? null) as typeof newId;
  }
  if (newId === null) newId = db.lastInsertId();
  if (newId !== null && newId !== undefined) instance[pk] = newId;
}

async function executeModelInsert(
  instance: BaseModel,
  model: typeof BaseModel,
  db: DatabaseAdapter,
  pk: string,
  pkCol: string,
  pkField: FieldDefinition | undefined,
): Promise<void> {
  const statement = buildInsertStatement(instance, model, db, pkField, pkCol);
  const result = await adapterExecute(db, statement.sql, statement.values);
  if (pkField?.autoIncrement) applyInsertedId(instance, db, result, pk, pkCol);
}

function saveDatabaseFailure(instance: BaseModel, model: typeof BaseModel, db: DatabaseAdapter, error: unknown): false {
  const adapter = db as any;
  const adapterError = typeof adapter.getError === "function" ? adapter.getError() :
    typeof adapter.getLastError === "function" ? adapter.getLastError() : null;
  let cause = String(adapterError || (error instanceof Error ? error.message : error));
  const low = cause.toLowerCase();
  if (model.softDelete && low.includes("is_deleted") &&
      ["no such column", "has no column", "does not exist", "doesn't exist", "unknown column"].some((part) => low.includes(part))) {
    cause += " — softDelete=true needs an is_deleted column; declare it (is_deleted: { type: 'integer', default: 0 }), boot the server so syncModels() adds it, or run a migration";
  } else if (low.includes("no such table") ||
      ((low.includes("does not exist") || low.includes("doesn't exist")) && !low.includes("column"))) {
    cause += ` — table '${model.tableName}' does not exist; call ${model.name}.createTable() or run a migration`;
  }
  instance.lastError = cause;
  Log.error(`${model.name}.save() failed for table '${model.tableName}': ${instance.lastError}`);
  return false;
}

function serializeModelFields(instance: BaseModel, model: typeof BaseModel, case_: "camel" | "snake"): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(model.fields)) {
    if (instance[key] === undefined) continue;
    const outKey = case_ === "snake" ? (model.fieldMapping[key] ?? key) : key;
    result[outKey] = instance[key] instanceof Point ? (instance[key] as Point).geojson : instance[key];
  }
  if (model.softDelete && instance.is_deleted !== undefined) result.is_deleted = instance.is_deleted;
  return result;
}

function groupIncludedRelations(include: string[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const item of include) {
    const parts = item.split(".", 2);
    grouped[parts[0]] ??= [];
    if (parts.length > 1) grouped[parts[0]].push(parts[1]);
  }
  return grouped;
}

function serializeIncludedRelation(
  instance: BaseModel,
  model: typeof BaseModel,
  result: Record<string, unknown>,
  relName: string,
  nested: string[],
  case_: "camel" | "snake",
): void {
  const cache = (instance as unknown as { _relCache: Record<string, unknown> })._relCache;
  const data = cache[relName];
  if (data === undefined) {
    Log.warning(
      `${model.name}.toDict(): relation "${relName}" was requested via include but was never eager-loaded ` +
      `(a synchronous serializer cannot lazy-load it), so it is OMITTED from the result. Pass ` +
      `include: ["${relName}"] to the finder (find/all/where/select/load) that produced this instance.`,
    );
    return;
  }
  if (data === null) {
    result[relName] = null;
    return;
  }
  const nestedInclude = nested.length > 0 ? nested : undefined;
  if (Array.isArray(data)) {
    result[relName] = (data as BaseModel[]).map((item) => item.toDict(nestedInclude, case_));
    return;
  }
  if (typeof (data as BaseModel).toDict === "function") {
    result[relName] = (data as BaseModel).toDict(nestedInclude, case_);
  }
}

function serializeIncludedRelations(
  instance: BaseModel,
  model: typeof BaseModel,
  result: Record<string, unknown>,
  include: string[],
  case_: "camel" | "snake",
): void {
  const grouped = groupIncludedRelations(include);
  for (const [relName, nested] of Object.entries(grouped)) {
    serializeIncludedRelation(instance, model, result, relName, nested, case_);
  }
}

function serializeLoadedRelations(instance: BaseModel, model: typeof BaseModel, result: Record<string, unknown>): void {
  for (const relation of model.hasOne ?? []) {
    const key = relation.model.toLowerCase();
    if (instance[key] !== undefined) result[key] = instance[key];
  }
  for (const relation of model.hasMany ?? []) {
    const base = relation.model.toLowerCase();
    const key = _pluralRelKeys() ? base + "s" : base;
    if (instance[key] !== undefined) result[key] = instance[key];
  }
}

type EagerRelation = {
  definition: RelationshipDefinition;
  type: "hasOne" | "hasMany" | "belongsTo";
};

function findEagerRelation(model: typeof BaseModel, name: string): EagerRelation | undefined {
  const want = name.toLowerCase();
  const matches = (relation: RelationshipDefinition): boolean => {
    const base = relation.model.toLowerCase();
    const related = BaseModel._modelRegistry[relation.model];
    const table = related?.tableName?.toLowerCase();
    const relatedName = relation.relatedName?.toLowerCase();
    return base === want || base + "s" === want || relatedName === want || table === want;
  };
  const candidates: Array<[RelationshipDefinition[] | undefined, EagerRelation["type"]]> = [
    [model.hasOne, "hasOne"],
    [model.hasMany, "hasMany"],
    [model.belongsTo, "belongsTo"],
  ];
  for (const [relations, type] of candidates) {
    const definition = relations?.find(matches);
    if (definition) return { definition, type };
  }
  return undefined;
}

function relationshipCache(instance: BaseModel): Record<string, unknown> {
  return (instance as unknown as { _relCache: Record<string, unknown> })._relCache;
}

function reverseMappedColumn(model: typeof BaseModel, column: string): string {
  return model.getReverseMapping()[column] ?? column;
}

async function eagerQueryRelated(
  relatedClass: typeof BaseModel,
  column: string,
  values: unknown[],
): Promise<BaseModel[]> {
  const db = (relatedClass as unknown as { getDb(): DatabaseAdapter }).getDb();
  const related: BaseModel[] = [];
  for (const chunk of _chunk(values, EAGER_IN_CHUNK)) {
    const placeholders = chunk.map(() => "?").join(",");
    let sql = `SELECT * FROM "${relatedClass.tableName}" WHERE "${column}" IN (${placeholders})`;
    if (relatedClass.softDelete) sql += " AND is_deleted = 0";
    const rows = await adapterQuery(db, sql, chunk);
    for (const row of rows) related.push(new relatedClass(row as Record<string, unknown>));
  }
  return related;
}

async function eagerLoadHasRelation(
  instances: BaseModel[],
  model: typeof BaseModel,
  relatedClass: typeof BaseModel,
  relationName: string,
  nested: string[],
  relation: RelationshipDefinition,
  type: "hasOne" | "hasMany",
): Promise<void> {
  const pk = primaryKeyFields(model)[0];
  const values = instances.map((instance) => instance[pk]).filter((value) => value !== undefined && value !== null);
  if (values.length === 0) return;
  const related = await eagerQueryRelated(relatedClass, relation.foreignKey, values);
  if (nested.length > 0 && related.length > 0) await relatedClass._eagerLoad(related, nested);
  const fkProp = reverseMappedColumn(relatedClass, relation.foreignKey);
  const grouped: Record<string, BaseModel[]> = {};
  for (const record of related) {
    const key = _joinKey(record[fkProp]);
    (grouped[key] ??= []).push(record);
  }
  for (const instance of instances) {
    const records = grouped[_joinKey(instance[pk])] ?? [];
    relationshipCache(instance)[relationName] = type === "hasOne" ? records[0] ?? null : records;
  }
}

async function eagerLoadBelongsToRelation(
  instances: BaseModel[],
  model: typeof BaseModel,
  relatedClass: typeof BaseModel,
  relationName: string,
  nested: string[],
  relation: RelationshipDefinition,
): Promise<void> {
  const fkProp = reverseMappedColumn(model, relation.foreignKey);
  const values = [...new Set(instances.map((instance) => instance[fkProp]).filter((value) => value !== undefined && value !== null))];
  if (values.length === 0) return;
  const relatedPk = primaryKeyFields(relatedClass)[0];
  const relatedPkColumn = relatedClass.getDbColumn(relatedPk);
  const related = await eagerQueryRelated(relatedClass, relatedPkColumn, values);
  if (nested.length > 0 && related.length > 0) await relatedClass._eagerLoad(related, nested);
  const lookup: Record<string, BaseModel> = {};
  for (const record of related) lookup[_joinKey(record[relatedPk])] = record;
  for (const instance of instances) {
    const value = instance[fkProp];
    relationshipCache(instance)[relationName] = value !== undefined && value !== null
      ? lookup[_joinKey(value)] ?? null
      : null;
  }
}

async function eagerLoadRelation(
  instances: BaseModel[],
  model: typeof BaseModel,
  relationName: string,
  nested: string[],
): Promise<void> {
  const found = findEagerRelation(model, relationName);
  if (!found) {
    Log.warning(
      `eager-load: include "${relationName}" did not match any relationship on ${model.name} ` +
      `(table "${model.tableName}"). Accepted forms are the related model name, its ` +
      `singular/plural key, or the related table name (case-insensitive).`,
    );
    return;
  }
  const relatedClass = BaseModel._modelRegistry[found.definition.model];
  if (!relatedClass) return;
  if (found.type === "belongsTo") {
    await eagerLoadBelongsToRelation(instances, model, relatedClass, relationName, nested, found.definition);
    return;
  }
  await eagerLoadHasRelation(instances, model, relatedClass, relationName, nested, found.definition, found.type);
}

/** Whether the adapter can emit engine-specific CREATE TABLE DDL. */
function hasAdapterCreateTable(db: DatabaseAdapter): boolean {
  return typeof db.createTable === "function" || typeof (db as any).createTableAsync === "function";
}

/**
 * Map model fields to adapter column names while removing callable defaults.
 * Callable defaults are resolved per row by the model constructor and must not
 * be stringified into adapter DDL.
 */
function mappedCreateTableFields(model: typeof BaseModel): Record<string, FieldDefinition> {
  const mapped: Record<string, FieldDefinition> = {};
  for (const [fieldName, def] of Object.entries(model.fields)) {
    const dbCol = model.getDbColumn(fieldName);
    if (typeof def.default === "function") {
      const { default: _callableDefault, ...rest } = def;
      mapped[dbCol] = rest;
    } else {
      mapped[dbCol] = def;
    }
  }
  return mapped;
}

/** Add the implicit soft-delete column when a model has not declared it. */
function addSoftDeleteField(model: typeof BaseModel, fields: Record<string, FieldDefinition>): void {
  if (model.softDelete && !("is_deleted" in fields)) {
    fields.is_deleted = { type: "integer", default: 0 };
  }
}

function primaryKeyFields(model: typeof BaseModel): string[] {
  const keys = Object.entries(model.fields)
    .filter(([, def]) => def.primaryKey)
    .map(([name]) => name);
  return keys.length > 0 ? keys : ["id"];
}

const FALLBACK_COLUMN_TYPES: Record<string, string> = {
  integer: "INTEGER",
  string: "TEXT",
  text: "TEXT",
  number: "REAL",
  numeric: "REAL",
  boolean: "INTEGER",
  datetime: "TEXT",
};

function fallbackColumnDefinition(model: typeof BaseModel, fieldName: string, def: FieldDefinition): string {
  const dbCol = model.getDbColumn(fieldName);
  const parts = [`"${dbCol}" ${FALLBACK_COLUMN_TYPES[def.type] || "TEXT"}`];
  if (def.primaryKey && primaryKeyFields(model).length === 1) parts.push("PRIMARY KEY");
  if (def.autoIncrement) parts.push("AUTOINCREMENT");
  if (def.required && !def.primaryKey) parts.push("NOT NULL");
  if (def.default !== undefined && typeof def.default !== "function") {
    const value = typeof def.default === "string" ? `'${def.default}'` : String(def.default);
    parts.push(`DEFAULT ${value}`);
  }
  return parts.join(" ");
}

function fallbackPrimaryKeyDefinition(model: typeof BaseModel): string | undefined {
  const pkFields = primaryKeyFields(model);
  if (pkFields.length <= 1) return undefined;
  const pkCols = pkFields.map((fieldName) => model.getDbColumn(fieldName));
  return `PRIMARY KEY (${pkCols.join(", ")})`;
}

function fallbackColumnDefinitions(model: typeof BaseModel): string[] {
  const definitions = Object.entries(model.fields).map(([fieldName, def]) => fallbackColumnDefinition(model, fieldName, def));
  const dbCols = Object.keys(model.fields).map((fieldName) => model.getDbColumn(fieldName));
  if (model.softDelete && !dbCols.includes("is_deleted")) definitions.push('"is_deleted" INTEGER DEFAULT 0');
  const primaryKey = fallbackPrimaryKeyDefinition(model);
  if (primaryKey) definitions.push(primaryKey);
  return definitions;
}

async function createFallbackTable(db: DatabaseAdapter, model: typeof BaseModel): Promise<void> {
  const definitions = fallbackColumnDefinitions(model);
  const sql = `CREATE TABLE IF NOT EXISTS "${model.tableName}" (${definitions.join(", ")})`;
  await adapterStartTransaction(db);
  try {
    await adapterExecute(db, sql);
    await adapterCommit(db);
  } catch (e) {
    await adapterRollback(db);
    throw e;
  }
}
