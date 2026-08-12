import {
  getAdapter, getNamedAdapter, setAdapter, parseDatabaseUrl,
  adapterQuery, adapterFetch, adapterExecute, adapterFetchOne,
  adapterStartTransaction, adapterCommit, adapterRollback,
  adapterTableExists, adapterCreateTable, extractLastInsertId,
  DEFAULT_ROW_CAP,
} from "./database.js";
import { validate as validateFields } from "./validation.js";
import { QueryBuilder } from "./queryBuilder.js";
import { SQLiteAdapter } from "./adapters/sqlite.js";
import { QueryCache, SQLTranslator } from "./sqlTranslator.js";
import { Log } from "../../core/src/index.js";
import type { DatabaseAdapter, FieldDefinition, RelationshipDefinition } from "./types.js";

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
      if (dv !== null && typeof dv === "object") dv = structuredClone(dv);
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
    return QueryBuilder.fromTable(this.tableName, this.getDb());
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
  ): Promise<T[]>;
  static async find<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    filter?: Record<string, unknown> | number | string,
    limit: number | string[] = 100,
    offset = 0,
    orderBy?: string,
    include?: string[],
  ): Promise<T[] | T | null> {
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
    const db = ModelClass.getDb();
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

    const rows = await adapterFetch(db, sql, params, lim, offset);
    const data = (rows as any)?.data ?? rows;
    const instances = (Array.isArray(data) ? data : []).map((row: Record<string, unknown>) => {
      const inst = new this(row) as T;
      (inst as any)._exists = true;
      return inst;
    });

    if (include) {
      await ModelClass._eagerLoad(instances as BaseModel[], include);
    }

    return instances;
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
    (this as any)._exists = true;
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
  ): Promise<T[]> {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    const db = ModelClass.getDb();

    const conditions: string[] = [];
    if (ModelClass.softDelete) {
      conditions.push("is_deleted = 0");
    }
    if (ModelClass.tableFilter) {
      conditions.push(ModelClass.tableFilter);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const orderClause = orderBy ? ` ORDER BY ${orderBy}` : "";
    const sql = `SELECT * FROM "${ModelClass.tableName}"${whereClause}${orderClause}`
      + ` LIMIT ${limit} OFFSET ${offset}`;

    // No bind parameters: the only conditions left are the framework's own
    // softDelete / tableFilter literals. A caller-supplied filter belongs on
    // where(), which binds its params properly.
    const rows = await adapterQuery(db, sql, []);
    const instances = rows.map((row) => new ModelClass(row as Record<string, unknown>) as T);
    if (include) {
      await ModelClass._eagerLoad(instances, include);
    }
    return instances;
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
  ): Promise<T[]> {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    const db = ModelClass.getDb();

    const parts: string[] = [];
    if (ModelClass.softDelete) {
      parts.push("is_deleted = 0");
    }
    if (ModelClass.tableFilter) {
      parts.push(ModelClass.tableFilter);
    }
    parts.push(`(${conditions})`);

    const orderClause = orderBy ? ` ORDER BY ${orderBy}` : "";
    const sql = `SELECT * FROM "${ModelClass.tableName}" WHERE ${parts.join(" AND ")}${orderClause} LIMIT ${limit} OFFSET ${offset}`;

    const rows = await adapterQuery(db, sql, params);
    const instances = rows.map((row) => new ModelClass(row as Record<string, unknown>) as T);
    if (include) {
      await ModelClass._eagerLoad(instances, include);
    }
    return instances;
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

    // ── Canonical #2: validate() is enforced. An invalid model never reaches
    // the driver — fail loud (log + lastError), return false. ──
    const errors = this.validate();
    if (errors.length > 0) {
      this.lastError = errors.join("; ");
      Log.error(
        `${ModelClass.name}.save() refused: validation failed for table ` +
          `'${ModelClass.tableName}' — ${this.lastError}`,
      );
      return false;
    }

    const db = ModelClass.getDb();
    const pk = ModelClass.getPkField();
    const pkCol = ModelClass.getPkColumn();
    const pkValue = this[pk];
    const pkField = (ModelClass.fields as Record<string, FieldDefinition>)[pk];
    this._relCache = {}; // Clear relationship cache on save

    // v3.13.11 (issue #50.2): for non-auto-increment PKs (user-supplied
    // string IDs like "GC-100"), decide INSERT vs UPDATE on row
    // existence, not on whether the PK is set. Pre-v3.13.11 a
    // natural-key save() always chose UPDATE → matched zero rows →
    // silently returned success without inserting anything.
    //
    // Auto-increment behaviour is unchanged: pkValue is null/undefined
    // → INSERT, pkValue is set → UPDATE.
    let isUpdate = false;
    if (pkValue !== undefined && pkValue !== null) {
      if (pkField?.autoIncrement) {
        isUpdate = true;
      } else {
        try {
          // This asked exists(pkValue), which tests only the FIRST key column.
          // On a composite key that is true for any row sharing that column, so
          // inserting a genuinely NEW row was decided to be an UPDATE and
          // silently OVERWROTE a different row: saving (acme, a2) rewrote
          // (acme, a1). The check has to name the whole key, like the write
          // that follows it.
          const probe = this.pkWhere();
          if (ModelClass.getPkFields().length > 1 && probe.sql) {
            const found = await db.fetch(
              `SELECT 1 AS present FROM ${ModelClass.tableName} WHERE ${probe.sql}`,
              probe.params,
              1,
            );
            isUpdate = (found as unknown as { length: number }).length > 0;
          } else {
            isUpdate = await ModelClass.exists(pkValue);
          }
        } catch {
          // If we can't tell (e.g. table doesn't exist yet), fall back
          // to INSERT so the user sees the real driver error rather
          // than a silent no-op.
          isUpdate = false;
        }
      }
    }

    await adapterStartTransaction(db);
    try {
      if (isUpdate) {
        // Update — keyed on the WHOLE primary key (see pkWhere).
        const updateFields = Object.entries(ModelClass.fields).filter(
          ([name, def]) => !def.primaryKey && this[name] !== undefined,
        );
        if (updateFields.length === 0) { await adapterCommit(db); return this; }

        const setClause = updateFields.map(([k]) => `"${ModelClass.getDbColumn(k)}" = ?`).join(", ");
        // The key params come from pkWhere() below; appending pkValue here too
        // would bind the first key column twice and shift every placeholder.
        const values = [...updateFields.map(([k, def]) => toDbFieldValue(def, this[k]))];

        // Keyed on the WHOLE primary key: one column of a composite key matches
        // every row sharing that value.
        const uw = this.pkWhere();
        values.push(...uw.params);
        await adapterExecute(db, `UPDATE "${ModelClass.tableName}" SET ${setClause} WHERE ${uw.sql}`, values);
      } else {
        // Insert
        //
        // #165: an INSERT must OMIT a column the caller never assigned so a
        // `NOT NULL DEFAULT <x>` column gets its DB default instead of an
        // explicit NULL that violates the constraint. In TS an unset column is
        // `undefined` (the constructor only seeds a field that declares a
        // non-null ORM default — everything else stays `undefined`), so the
        // `this[name] !== undefined` filter already drops unset columns; a
        // value the caller set to `null` IS included and written as an explicit
        // NULL (parity with Python's _assigned_fields split — JS distinguishes
        // undefined-unset from null-explicit natively). A resolved non-null ORM
        // default is still written (no regression).
        const insertFields = Object.entries(ModelClass.fields).filter(
          ([name, def]) => !(def.primaryKey && def.autoIncrement) && this[name] !== undefined,
        );

        // For auto-increment PKs on engines that need it (PostgreSQL),
        // RETURNING the PK column lets us read the engine-assigned id back.
        // SQLite ignores the RETURNING clause harmlessly (it supports it
        // since 3.35) and we still prefer its lastInsertRowid; for other
        // engines extractLastInsertId() reads rows[0].id.
        const wantReturning = pkField?.autoIncrement && db.constructor.name !== "SQLiteAdapter";
        const returningClause = wantReturning ? ` RETURNING "${pkCol}"` : "";

        let insertSql: string;
        let values: unknown[];
        if (insertFields.length === 0) {
          // #165: every insertable column was left unset — let the DB apply ALL
          // its column defaults rather than emitting an empty column list
          // (`() VALUES ()` is invalid on SQLite/PostgreSQL/Firebird/MSSQL, which
          // spell the all-defaults insert `DEFAULT VALUES`; only MySQL uses the
          // empty-parens form). Mirrors the Python master's engine split.
          insertSql =
            (db.constructor.name === "MysqlAdapter"
              ? `INSERT INTO "${ModelClass.tableName}" () VALUES ()`
              : `INSERT INTO "${ModelClass.tableName}" DEFAULT VALUES`) + returningClause;
          values = [];
        } else {
          const columns = insertFields.map(([k]) => `"${ModelClass.getDbColumn(k)}"`).join(", ");
          const placeholders = insertFields.map(() => "?").join(", ");
          values = insertFields.map(([k, def]) => toDbFieldValue(def, this[k]));
          insertSql =
            `INSERT INTO "${ModelClass.tableName}" (${columns}) VALUES (${placeholders})` +
            returningClause;
        }

        const result = await adapterExecute(db, insertSql, values);

        // v3.13.11 (issue #50.2): only adopt the engine-assigned ID
        // for auto-increment PKs. A natural-key PK was already set by
        // the caller; don't overwrite it with the driver's last_id.
        if (pkField?.autoIncrement) {
          // RETURNING result: pg puts it in rows[0][pkCol]; normalise here.
          // string is allowed for a non-integer PK surfaced by lastInsertId()
          // (e.g. a PostgreSQL UUID PK) — #256.
          let newId: number | bigint | string | null = extractLastInsertId(result);
          if (newId === null && result && typeof result === "object") {
            const rows = (result as any).rows;
            if (Array.isArray(rows) && rows[0]) {
              newId = rows[0][pkCol] ?? rows[0].id ?? null;
            }
          }
          if (newId === null) {
            // Fall back to the adapter's tracked last id (MySQL/MSSQL).
            newId = db.lastInsertId();
          }
          if (newId !== null && newId !== undefined) {
            this[pk] = newId;
          }
        }
      }
      await adapterCommit(db);
    } catch (e: any) {
      await adapterRollback(db);
      // ── Canonical #1: fail loud, never silent. Keep the false return
      // contract, but capture the REAL cause (prefer the adapter's
      // getError()/getLastError() when present, falling back to the exception
      // text) on this.lastError so it survives, and log it with model/table
      // context. ──
      const adapterErr =
        typeof (db as any).getError === "function" ? (db as any).getError() :
        typeof (db as any).getLastError === "function" ? (db as any).getLastError() :
        null;
      let cause = adapterErr || e?.message || String(e);
      // ── DX hint (v3.13.60 parity with the Python master): turn a bare driver
      // error into an actionable fix for the two commonest ORM write footguns.
      // Matched case-insensitively (SQLite via node:sqlite: "no such table" /
      // "no such column: is_deleted" / "has no column named is_deleted";
      // Postgres/MySQL: "does not exist" / "doesn't exist" / "unknown column").
      // Any OTHER error keeps its raw cause untouched so an unrelated failure
      // (NOT NULL, duplicate PK) is never masked. ──
      const low = cause.toLowerCase();
      if (
        ModelClass.softDelete && low.includes("is_deleted") &&
        (low.includes("no such column") || low.includes("has no column") ||
          low.includes("does not exist") || low.includes("doesn't exist") ||
          low.includes("unknown column"))
      ) {
        cause +=
          " — softDelete=true needs an is_deleted column; declare it " +
          "(is_deleted: { type: 'integer', default: 0 }), boot the server so " +
          "syncModels() adds it, or run a migration";
      } else if (
        low.includes("no such table") ||
        ((low.includes("does not exist") || low.includes("doesn't exist")) &&
          !low.includes("column"))
      ) {
        cause +=
          ` — table '${ModelClass.tableName}' does not exist; call ` +
          `${ModelClass.name}.createTable() or run a migration`;
      }
      this.lastError = cause;
      Log.error(
        `${ModelClass.name}.save() failed for table ` +
          `'${ModelClass.tableName}': ${this.lastError}`,
      );
      return false;
    }
    // Success — clear any previously-recorded error.
    this.lastError = null;
    (this as any)._exists = true;
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
    const pkCol = ModelClass.getPkColumn();
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
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(ModelClass.fields)) {
      if (this[key] !== undefined) {
        const outKey = case_ === "snake" ? (ModelClass.fieldMapping[key] ?? key) : key;
        result[outKey] = this[key];
      }
    }
    // Include soft delete field
    if (ModelClass.softDelete && this.is_deleted !== undefined) {
      result.is_deleted = this.is_deleted;
    }

    if (include) {
      // Group includes: top-level and nested
      const topLevel: Record<string, string[]> = {};
      for (const inc of include) {
        const parts = inc.split(".", 2);
        const relName = parts[0];
        if (!topLevel[relName]) {
          topLevel[relName] = [];
        }
        if (parts.length > 1) {
          topLevel[relName].push(parts[1]);
        }
      }

      for (const [relName, nested] of Object.entries(topLevel)) {
        // toDict stays synchronous (used in routes, templates, serialization).
        // Relationships must be eager-loaded first (await Model._eagerLoad / the
        // include arg on find/all/where) which fills _relCache. A relation that
        // isn't cached is simply skipped here — async lazy-load on a sync
        // serializer is not possible after the Option A async refactor.
        const data = this._relCache[relName];
        if (data === undefined) continue;
        if (data === null || data === undefined) {
          result[relName] = null;
        } else if (Array.isArray(data)) {
          result[relName] = (data as BaseModel[]).map((r) =>
            r.toDict(nested.length > 0 ? nested : undefined, case_),
          );
        } else if (typeof (data as BaseModel).toDict === "function") {
          result[relName] = (data as BaseModel).toDict(
            nested.length > 0 ? nested : undefined, case_,
          );
        }
      }
    } else {
      // Legacy: include any relationship data already loaded on instance
      if (ModelClass.hasOne) {
        for (const rel of ModelClass.hasOne) {
          const relKey = rel.model.toLowerCase();
          if (this[relKey] !== undefined) {
            result[relKey] = this[relKey];
          }
        }
      }
      if (ModelClass.hasMany) {
        for (const rel of ModelClass.hasMany) {
          const base = rel.model.toLowerCase();
          const relKey = _pluralRelKeys() ? base + "s" : base;
          if (this[relKey] !== undefined) {
            result[relKey] = this[relKey];
          }
        }
      }
    }

    return result;
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
  validate(): string[] {
    const ModelClass = this.constructor as typeof BaseModel;
    const data: Record<string, unknown> = {};
    for (const name of Object.keys(ModelClass.fields)) {
      data[name] = this[name];
    }
    const errors = validateFields(data, ModelClass.fields);
    return errors.map((e) => `${e.field} ${e.message}`);
  }

  /**
   * Generate and execute CREATE TABLE DDL from the model's field definitions.
   * Uses the adapter's createTable method if available, otherwise builds SQL directly.
   */
  static async createTable(): Promise<boolean> {
    const db = this.getDb();
    if (await adapterTableExists(db, this.tableName)) return true;

    // Prefer the adapter's createTable — every adapter implements it and the
    // async variants (PostgreSQL/MySQL/MSSQL/Firebird) emit engine-aware DDL
    // (datetime → TIMESTAMP, boolean → native BOOLEAN, auto-increment → SERIAL
    // etc. on PG). Remap field keys to DB column names if fieldMapping exists.
    if (typeof db.createTable === "function" || typeof (db as any).createTableAsync === "function") {
      const mappedFields: Record<string, FieldDefinition> = {};
      for (const [fieldName, def] of Object.entries(this.fields)) {
        const dbCol = this.getDbColumn(fieldName);
        // A callable default (e.g. `default: () => new Date()`) is resolved per-row
        // in the constructor; it must NOT reach the adapter DDL builder, where it
        // stringifies to an invalid `DEFAULT () => ...` and silently fails table
        // creation. Drop the default key so no adapter emits it (parity with Python #61).
        if (typeof def.default === "function") {
          const { default: _callableDefault, ...rest } = def;
          mappedFields[dbCol] = rest;
        } else {
          mappedFields[dbCol] = def;
        }
      }
      await adapterCreateTable(db, this.tableName, mappedFields);
      return true;
    }

    // Fallback: build SQL manually (SQLite-only dialect — used only when an
    // adapter lacks createTable, which none currently do).
    const typeMap: Record<string, string> = {
      integer: "INTEGER",
      string: "TEXT",
      text: "TEXT",
      number: "REAL",
      numeric: "REAL",
      boolean: "INTEGER",
      datetime: "TEXT",
    };

    const colDefs: string[] = [];
    for (const [fieldName, def] of Object.entries(this.fields)) {
      const dbCol = this.getDbColumn(fieldName);
      const sqlType = typeMap[def.type] || "TEXT";
      const parts = [`"${dbCol}" ${sqlType}`];
      // A COMPOSITE key is declared ONCE, at table level (below). An inline
      // PRIMARY KEY per column is invalid DDL - SQLite, PostgreSQL and MySQL
      // all reject two of them in one table.
      if (def.primaryKey && this.getPkFields().length === 1) parts.push("PRIMARY KEY");
      if (def.autoIncrement) parts.push("AUTOINCREMENT");
      if (def.required && !def.primaryKey) parts.push("NOT NULL");
      // A callable default (e.g. `default: () => new Date()`) is resolved per-row
      // in the constructor above; it must NOT be emitted into the CREATE TABLE
      // DDL, where String(fn) stringifies to `DEFAULT () => ...` — invalid SQL
      // that silently fails table creation (parity with Python #61).
      if (def.default !== undefined && typeof def.default !== "function") {
        const dv = typeof def.default === "string" ? `'${def.default}'` : String(def.default);
        parts.push(`DEFAULT ${dv}`);
      }
      colDefs.push(parts.join(" "));
    }

    // A COMPOSITE key is declared ONCE, at table level; the per-column inline
    // form above is suppressed for it, because two inline primary keys is
    // invalid DDL on every engine.
    const pkFields = this.getPkFields();
    if (pkFields.length > 1) {
      const pkCols = pkFields.map((f) => this.getDbColumn(f));
      colDefs.push(`PRIMARY KEY (${pkCols.join(", ")})`);
    }

    const sql = `CREATE TABLE IF NOT EXISTS "${this.tableName}" (${colDefs.join(", ")})`;
    await adapterStartTransaction(db);
    try {
      await adapterExecute(db, sql);
      await adapterCommit(db);
    } catch (e) {
      await adapterRollback(db);
      throw e;
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
   * Tag-scoped, NOT a wholesale flush: a cached JOIN on another model that reads
   * this table is busted too (it carries this table's tag), while a query that
   * never touches this table is left intact. Called after every ORM write
   * (save/delete/forceDelete/restore) so a read-after-write never serves a
   * stale/deleted row (CACHE-DEC-01).
   */
  static clearCache(): void {
    const ModelClass = this as unknown as typeof BaseModel;
    modelQueryCache.clearTag((ModelClass.tableName ?? "").toLowerCase());
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
  ): Promise<T[]> {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    const db = ModelClass.getDb();
    // Skip appending when the caller's SQL already carries its own LIMIT --
    // a second one is a syntax error on every engine. SQLTranslator.appendLimit
    // scrubs literals/comments first (a substring search here used to drop the
    // row cap on `WHERE label != 'LIMIT'`) and appends on a new line so the
    // clause is never swallowed by a trailing `--` comment.
    const paged = SQLTranslator.appendLimit(sql, limit, offset);
    const rows = await adapterQuery(db, paged, params);
    return rows.map((row) => new ModelClass(row as Record<string, unknown>) as T);
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
    const pkCol = ModelClass.getPkColumn();
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
    const pkCol = ModelClass.getPkColumn();
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
  ): Promise<T[]> {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    const db = ModelClass.getDb();

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
    if (limit !== undefined) {
      sql += ` LIMIT ${limit}`;
    }
    if (offset !== undefined) {
      sql += ` OFFSET ${offset}`;
    }

    const rows = await adapterQuery(db, sql, params);
    return rows.map((row) => new ModelClass(row as Record<string, unknown>) as T);
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
    return related;
  }

  /**
   * Load has-many related model instances.
   */
  async hasMany<T extends BaseModel, R extends BaseModel>(
    this: T,
    relatedClass: typeof BaseModel & (new (data?: Record<string, unknown>) => R),
    foreignKey: string,
    limit: number = 100,
    offset: number = 0,
  ): Promise<R[]> {
    const ModelClass = this.constructor as typeof BaseModel;
    const pk = ModelClass.getPkField();
    const pkValue = this[pk];

    if (pkValue === undefined || pkValue === null) {
      return [];
    }

    const db = relatedClass.getDb();
    let sql = `SELECT * FROM "${relatedClass.tableName}" WHERE "${foreignKey}" = ?`;
    if (relatedClass.softDelete) {
      sql += ` AND is_deleted = 0`;
    }
    sql += ` LIMIT ${limit} OFFSET ${offset}`;

    const rows = await adapterQuery(db, sql, [pkValue]);
    const related = rows.map((row) => new relatedClass(row as Record<string, unknown>) as R);
    const relKey = relatedClass.tableName.toLowerCase();
    // See hasOne: write through BaseModel's writable index signature (TS2862).
    (this as BaseModel)[relKey] = related;
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
    return related;
  }

  /**
   * Register a model class for lookup by name (used by eager loading).
   */
  static _modelRegistry: Record<string, typeof BaseModel> = {};

  static registerModel(name: string, modelClass: typeof BaseModel): void {
    BaseModel._modelRegistry[name] = modelClass;
    // Eagerly process this model's foreignKey fields so the cross-model
    // _fkRegistry is populated as soon as the model is known — not only when
    // the *declaring* model happens to be touched first. This is what makes
    // eager loading work standalone (without server-boot auto-discovery):
    // a parent's hasMany is registered by the child's _processForeignKeys(),
    // so we must run it for every registered model proactively.
    modelClass._processForeignKeys();
  }

  /**
   * Process foreignKey fields on every registered model so the cross-model
   * _fkRegistry (and each model's belongsTo/hasMany) is fully wired regardless
   * of which model was used first. Idempotent — _processForeignKeys() and
   * _applyFkRegistry() both guard against duplicates.
   */
  private static _processAllForeignKeys(): void {
    for (const modelClass of Object.values(BaseModel._modelRegistry)) {
      modelClass._processForeignKeys();
    }
    for (const modelClass of Object.values(BaseModel._modelRegistry)) {
      modelClass._applyFkRegistry();
    }
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

    // Group includes: top-level and nested
    const topLevel: Record<string, string[]> = {};
    for (const inc of include) {
      const parts = inc.split(".", 2);
      const relName = parts[0];
      if (!topLevel[relName]) {
        topLevel[relName] = [];
      }
      if (parts.length > 1) {
        topLevel[relName].push(parts[1]);
      }
    }

    for (const [relName, nested] of Object.entries(topLevel)) {
      // Find the relationship definition.
      //
      // Include names are resolved case-insensitively against each candidate
      // relation. Accepted forms (for a relation to model "Post" on table "posts"):
      //   - the model name           → "Post" / "post"
      //   - the auto/related key     → "post" (singular) or "posts" (when
      //                                 TINA4_ORM_PLURAL_TABLE_NAMES is enabled)
      //   - the table name           → "posts"
      // All matching is lower-cased so "Post", "post" and "posts" all resolve.
      const want = relName.toLowerCase();
      let relDef: RelationshipDefinition | undefined;
      let relType: "hasOne" | "hasMany" | "belongsTo" | null = null;

      const matchesModel = (r: RelationshipDefinition): boolean => {
        const base = r.model.toLowerCase();
        const related = BaseModel._modelRegistry[r.model];
        const table = related?.tableName?.toLowerCase();
        // Outlier F: an FK-auto-wired has-many carries its derived key
        // (declaring class lowercased + "s", or relatedName) — match it so
        // include: ["posts"] resolves to the wired relation regardless of the
        // related table name.
        const rel = r.relatedName?.toLowerCase();
        return (
          base === want ||
          base + "s" === want ||
          (rel !== undefined && rel === want) ||
          (table !== undefined && table === want)
        );
      };

      if (ModelClass.hasOne) {
        relDef = ModelClass.hasOne.find(matchesModel);
        if (relDef) relType = "hasOne";
      }
      if (!relDef && ModelClass.hasMany) {
        relDef = ModelClass.hasMany.find(matchesModel);
        if (relDef) relType = "hasMany";
      }
      if (!relDef && ModelClass.belongsTo) {
        relDef = ModelClass.belongsTo.find(matchesModel);
        if (relDef) relType = "belongsTo";
      }

      if (!relDef || !relType) {
        // Don't silently skip — a typo'd or unknown include name is almost
        // always a developer mistake. Surface it so it's visible.
        Log.warn(
          `eager-load: include "${relName}" did not match any relationship on ` +
            `${ModelClass.name} (table "${ModelClass.tableName}"). ` +
            `Accepted forms are the related model name, its singular/plural ` +
            `key, or the related table name (case-insensitive).`,
        );
        continue;
      }

      const relatedClass = BaseModel._modelRegistry[relDef.model];
      if (!relatedClass) continue;

      const db = relatedClass.getDb();
      const fk = relDef.foreignKey;

      if (relType === "hasOne" || relType === "hasMany") {
        const pk = ModelClass.getPkField();
        const pkValues = instances
          .map((inst) => inst[pk])
          .filter((v) => v !== undefined && v !== null);
        if (pkValues.length === 0) continue;

        const placeholders = pkValues.map(() => "?").join(",");
        let sql = `SELECT * FROM "${relatedClass.tableName}" WHERE "${fk}" IN (${placeholders})`;
        if (relatedClass.softDelete) {
          sql += ` AND is_deleted = 0`;
        }

        const rows = await adapterQuery(db, sql, pkValues);
        const related = rows.map((row) => new relatedClass(row as Record<string, unknown>));

        // Eager load nested
        if (nested.length > 0 && related.length > 0) {
          await relatedClass._eagerLoad(related, nested);
        }

        // Group by FK — fk is a DB column name, resolve to JS property name on the related model
        const relatedReverseMap = relatedClass.getReverseMapping();
        const fkProp = relatedReverseMap[fk] ?? fk;
        const grouped: Record<string, BaseModel[]> = {};
        for (const record of related) {
          const fkVal = String(record[fkProp]);
          if (!grouped[fkVal]) grouped[fkVal] = [];
          grouped[fkVal].push(record);
        }

        for (const inst of instances) {
          const pkVal = String(inst[pk]);
          const records = grouped[pkVal] || [];
          if (relType === "hasOne") {
            inst._relCache[relName] = records[0] ?? null;
          } else {
            inst._relCache[relName] = records;
          }
        }
      } else if (relType === "belongsTo") {
        // fk is a DB column name on the current model — resolve to JS property name
        const ownerReverseMap = ModelClass.getReverseMapping();
        const fkProp = ownerReverseMap[fk] ?? fk;
        const fkValues = [...new Set(
          instances
            .map((inst) => inst[fkProp])
            .filter((v) => v !== undefined && v !== null),
        )];
        if (fkValues.length === 0) continue;

        const relatedPk = relatedClass.getPkField();
        const relatedPkCol = relatedClass.getPkColumn();
        const placeholders = fkValues.map(() => "?").join(",");
        let sql = `SELECT * FROM "${relatedClass.tableName}" WHERE "${relatedPkCol}" IN (${placeholders})`;
        if (relatedClass.softDelete) {
          sql += ` AND is_deleted = 0`;
        }

        const rows = await adapterQuery(db, sql, fkValues);
        const related = rows.map((row) => new relatedClass(row as Record<string, unknown>));

        if (nested.length > 0 && related.length > 0) {
          await relatedClass._eagerLoad(related, nested);
        }

        const lookup: Record<string, BaseModel> = {};
        for (const record of related) {
          lookup[String(record[relatedPk])] = record;
        }

        for (const inst of instances) {
          const fkVal = inst[fkProp];
          inst._relCache[relName] = fkVal !== undefined && fkVal !== null
            ? lookup[String(fkVal)] ?? null
            : null;
        }
      }
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
