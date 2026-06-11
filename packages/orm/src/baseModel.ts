import { getAdapter, getNamedAdapter, setAdapter, parseDatabaseUrl } from "./database.js";
import { validate as validateFields } from "./validation.js";
import { QueryBuilder } from "./queryBuilder.js";
import { SQLiteAdapter } from "./adapters/sqlite.js";
import { QueryCache } from "./sqlTranslation.js";
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
export class BaseModel {
  static tableName: string;
  static fields: Record<string, FieldDefinition>;
  static softDelete?: boolean;
  static tableFilter?: string;
  static hasOne?: RelationshipDefinition[];
  static hasMany?: RelationshipDefinition[];
  static belongsTo?: RelationshipDefinition[];
  static _db?: string;
  static _queryCache?: QueryCache;

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

  constructor(data?: Record<string, unknown>) {
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
        this[jsProp] = value;
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
        result[dbCol] = this[key];
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

      // Register hasMany on the referenced model via the module-level registry
      const hasManyKey = def.relatedName ?? (this.tableName ?? this.name.toLowerCase());
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
        this.hasMany.push({ model: entry.declaringModel, foreignKey: entry.foreignKey });
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
        if (parsed.type === "sqlite") {
          // SQLite adapter is synchronous — create it inline and register as default
          const dbPath = parsed.path ?? "./data/tina4.db";
          const adapter = new SQLiteAdapter(dbPath);
          setAdapter(adapter);
          return adapter;
        }
        throw new Error(
          `TINA4_DATABASE_URL is set to a non-SQLite engine ("${parsed.type}"). ` +
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
  static findById<T extends BaseModel>(this: new (data?: Record<string, unknown>) => T, id: unknown, include?: string[]): T | null {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    const pkCol = ModelClass.getPkColumn();
    let sql = `SELECT * FROM "${ModelClass.tableName}" WHERE "${pkCol}" = ?`;

    if (ModelClass.softDelete) {
      sql += ` AND is_deleted = 0`;
    }
    if (ModelClass.tableFilter) {
      sql += ` AND ${ModelClass.tableFilter}`;
    }

    const instance = ModelClass.selectOne<T>(sql, [id]);
    if (instance && include) {
      ModelClass._eagerLoad([instance], include);
    }
    return instance;
  }

  /**
   * Create a new instance from data, save it, and return the saved instance.
   *
   * Usage:
   *   const user = User.create({ name: "Alice", email: "alice@example.com" });
   */
  static create<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    data: Record<string, unknown> = {},
  ): T {
    const instance = new this(data) as T;
    instance.save();
    return instance;
  }

  /**
   * Find records by filter dict. Always returns an array.
   *
   * Usage:
   *   User.find({ name: "Alice" })              → [User, ...]
   *   User.find({ age: 18 }, 10)                → [User, ...] (limit 10)
   *   User.find({}, 100, 0, "name ASC")         → [User, ...] (with orderBy)
   *   User.find()                                → all records
   *
   * Use findById(id) for single-record primary key lookup.
   */
  static find<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    filter?: Record<string, unknown>,
    limit = 100,
    offset = 0,
    orderBy?: string,
    include?: string[],
  ): T[] {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
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

    const rows = db.fetch(sql, params, limit, offset);
    const data = (rows as any)?.data ?? rows;
    const instances = (Array.isArray(data) ? data : []).map((row: Record<string, unknown>) => {
      const inst = new this(row) as T;
      (inst as any)._exists = true;
      return inst;
    });

    if (include) {
      ModelClass._eagerLoad(instances as BaseModel[], include);
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
  load(filter?: string, params?: unknown[], include?: string[]): boolean {
    const ModelClass = this.constructor as typeof BaseModel & (new (data?: Record<string, unknown>) => BaseModel);
    const table = (ModelClass as any).tableName ?? (this as any).tableName;

    let sql: string;
    if (filter === undefined || filter === null) {
      // No args — use PK already set
      const pk = (ModelClass as any).primaryKey ?? (this as any).primaryKey ?? "id";
      const pkValue = (this as any)[pk];
      if (pkValue === undefined || pkValue === null) return false;
      sql = `SELECT * FROM ${table} WHERE ${pk} = ?`;
      params = [pkValue];
    } else {
      sql = `SELECT * FROM ${table} WHERE ${filter}`;
    }

    const result = ModelClass.selectOne(sql, params, include);
    if (!result) return false;
    const data = (result as any).toJSON ? (result as any).toJSON() : result;
    for (const [key, value] of Object.entries(data)) {
      (this as any)[key] = value;
    }
    (this as any)._exists = true;
    return true;
  }

  /**
   * Find all records, optionally with a where clause.
   * Alias: all()
   * @param where Optional WHERE clause.
   * @param params Optional query parameters.
   * @param include Optional array of relationship names to eager-load.
   */
  static all<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    where?: string,
    params?: unknown[],
    include?: string[],
    orderBy?: string,
  ): T[] {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    const db = ModelClass.getDb();

    const conditions: string[] = [];
    if (ModelClass.softDelete) {
      conditions.push("is_deleted = 0");
    }
    if (ModelClass.tableFilter) {
      conditions.push(ModelClass.tableFilter);
    }
    if (where) {
      conditions.push(where);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const orderClause = orderBy ? ` ORDER BY ${orderBy}` : "";
    const sql = `SELECT * FROM "${ModelClass.tableName}"${whereClause}${orderClause}`;

    const rows = db.query(sql, params);
    const instances = rows.map((row) => new ModelClass(row as Record<string, unknown>) as T);
    if (include) {
      ModelClass._eagerLoad(instances, include);
    }
    return instances;
  }

  /**
   * Query records with a WHERE clause.
   * Matches Python/PHP/Ruby where() API.
   *
   * @param conditions WHERE clause (e.g. "age > ? AND active = ?")
   * @param params     Bind parameters
   * @param limit      Max records (default 20)
   * @param offset     Skip records (default 0)
   * @param include    Relationship names to eager-load
   */
  static where<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    conditions: string,
    params?: unknown[],
    limit: number = 20,
    offset: number = 0,
    include?: string[],
  ): T[] {
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

    const sql = `SELECT * FROM "${ModelClass.tableName}" WHERE ${parts.join(" AND ")} LIMIT ${limit} OFFSET ${offset}`;

    const rows = db.query(sql, params);
    const instances = rows.map((row) => new ModelClass(row as Record<string, unknown>) as T);
    if (include) {
      ModelClass._eagerLoad(instances, include);
    }
    return instances;
  }

  /**
   * Save this instance (insert or update).
   * Returns this on success (fluent), null on failure.
   */
  save(): this | false {
    const ModelClass = this.constructor as typeof BaseModel;
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
          isUpdate = ModelClass.exists(pkValue);
        } catch {
          // If we can't tell (e.g. table doesn't exist yet), fall back
          // to INSERT so the user sees the real driver error rather
          // than a silent no-op.
          isUpdate = false;
        }
      }
    }

    db.startTransaction();
    try {
      if (isUpdate) {
        // Update
        const updateFields = Object.entries(ModelClass.fields).filter(
          ([name, def]) => !def.primaryKey && this[name] !== undefined,
        );
        if (updateFields.length === 0) { db.commit(); return; }

        const setClause = updateFields.map(([k]) => `"${ModelClass.getDbColumn(k)}" = ?`).join(", ");
        const values = [...updateFields.map(([k]) => this[k]), pkValue];

        db.execute(`UPDATE "${ModelClass.tableName}" SET ${setClause} WHERE "${pkCol}" = ?`, values);
      } else {
        // Insert
        const insertFields = Object.entries(ModelClass.fields).filter(
          ([name, def]) => !(def.primaryKey && def.autoIncrement) && this[name] !== undefined,
        );

        const columns = insertFields.map(([k]) => `"${ModelClass.getDbColumn(k)}"`).join(", ");
        const placeholders = insertFields.map(() => "?").join(", ");
        const values = insertFields.map(([k]) => this[k]);

        const result = db.execute(
          `INSERT INTO "${ModelClass.tableName}" (${columns}) VALUES (${placeholders})`,
          values,
        ) as { lastInsertRowid?: number };

        // v3.13.11 (issue #50.2): only adopt the engine-assigned ID
        // for auto-increment PKs. A natural-key PK was already set by
        // the caller; don't overwrite it with the driver's last_id
        // (which on PG would be a sequence value that doesn't apply
        // to this row).
        if (result.lastInsertRowid && pkField?.autoIncrement) {
          this[pk] = result.lastInsertRowid;
        }
      }
      db.commit();
    } catch (e) {
      db.rollback();
      return false;
    }
    (this as any)._exists = true;
    return this;
  }

  /**
   * Delete this instance. Uses soft delete if configured.
   */
  delete(): boolean {
    const ModelClass = this.constructor as typeof BaseModel;
    const db = ModelClass.getDb();
    const pk = ModelClass.getPkField();
    const pkCol = ModelClass.getPkColumn();
    const pkValue = this[pk];

    if (pkValue === undefined || pkValue === null) {
      throw new Error("Cannot delete a model without a primary key value");
    }

    db.startTransaction();
    try {
      if (ModelClass.softDelete) {
        db.execute(
          `UPDATE "${ModelClass.tableName}" SET is_deleted = 1 WHERE "${pkCol}" = ?`,
          [pkValue],
        );
        this.is_deleted = 1;
      } else {
        db.execute(
          `DELETE FROM "${ModelClass.tableName}" WHERE "${pkCol}" = ?`,
          [pkValue],
        );
      }
      db.commit();
    } catch (e) {
      db.rollback();
      throw e;
    }
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
        const cached = this._relCache[relName];
        if (cached === undefined) {
          // Try lazy load via instance methods
          const related = this._lazyLoadRelationship(relName);
          if (related === undefined) continue;
          this._relCache[relName] = related;
        }
        const data = this._relCache[relName];
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
  static createTable(): boolean {
    const db = this.getDb();
    if (db.tableExists(this.tableName)) return true;

    if (typeof db.createTable === "function") {
      // Remap field keys to DB column names if fieldMapping is defined
      const mappedFields: Record<string, FieldDefinition> = {};
      for (const [fieldName, def] of Object.entries(this.fields)) {
        const dbCol = this.getDbColumn(fieldName);
        mappedFields[dbCol] = def;
      }
      db.createTable(this.tableName, mappedFields);
    } else {
      // Fallback: build SQL manually
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
        if (def.primaryKey) parts.push("PRIMARY KEY");
        if (def.autoIncrement) parts.push("AUTOINCREMENT");
        if (def.required && !def.primaryKey) parts.push("NOT NULL");
        if (def.default !== undefined) {
          const dv = typeof def.default === "string" ? `'${def.default}'` : String(def.default);
          parts.push(`DEFAULT ${dv}`);
        }
        colDefs.push(parts.join(" "));
      }

      const sql = `CREATE TABLE IF NOT EXISTS "${this.tableName}" (${colDefs.join(", ")})`;
      db.startTransaction();
      try {
        db.execute(sql);
        db.commit();
      } catch (e) {
        db.rollback();
        throw e;
      }
    }
    return true;
  }

  /**
   * Find a record by primary key or throw an error if not found.
   */
  static findOrFail<T extends BaseModel>(this: new (data?: Record<string, unknown>) => T, id: unknown): T {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    const result = ModelClass.findById(id) as T | null;
    if (result === null) {
      throw new Error(`${ModelClass.tableName}: record with id ${id} not found`);
    }
    return result;
  }

  /**
   * Return true if a record with the given primary key exists.
   */
  static exists(pkValue: unknown): boolean {
    const ModelClass = this as unknown as typeof BaseModel;
    return ModelClass.findById(pkValue) !== null;
  }

  /**
   * Run a raw SQL query with results cached by TTL. Cache is per-model-class.
   *
   * @param sql     SQL query string.
   * @param params  Bind parameters.
   * @param ttl     Cache TTL in seconds (default 60).
   * @param limit   Max records to return (default 20).
   * @param offset  Records to skip (default 0).
   * @param include Relationship names to eager-load on cache miss.
   */
  static cached<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    sql: string,
    params?: unknown[],
    ttl = 60,
    limit = 20,
    offset = 0,
    include?: string[],
  ): T[] {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    if (!ModelClass._queryCache) {
      ModelClass._queryCache = new QueryCache({ defaultTtl: ttl, maxSize: 500 });
    }
    const cacheKey = `${ModelClass.tableName}:${sql}:${limit}:${offset}`;
    const key = QueryCache.queryKey(cacheKey, params ?? []);
    const hit = ModelClass._queryCache.get(key) as T[] | undefined;
    if (hit !== undefined) return hit;

    const db = ModelClass.getDb();
    const querySql = `${sql} LIMIT ${limit} OFFSET ${offset}`;
    const rows = db.query(querySql, params);
    const results = rows.map((row) => new ModelClass(row as Record<string, unknown>) as T);
    if (include && results.length > 0) {
      ModelClass._eagerLoad(results as BaseModel[], include);
    }
    ModelClass._queryCache.set(key, results, ttl);
    return results;
  }

  /**
   * Clear the per-model query cache.
   */
  static clearCache(): void {
    const ModelClass = this as unknown as typeof BaseModel;
    if (ModelClass._queryCache) {
      ModelClass._queryCache.clear();
    }
  }

  /**
   * Execute a raw SQL SELECT and return results as model instances.
   */
  static select<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    sql: string,
    params?: unknown[],
  ): T[] {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    const db = ModelClass.getDb();
    const rows = db.query(sql, params);
    return rows.map((row) => new ModelClass(row as Record<string, unknown>) as T);
  }

  static selectOne<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    sql: string,
    params?: unknown[],
    include?: string[],
  ): T | null {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    const results = ModelClass.select<T>(sql, params);
    const instance = results[0] ?? null;
    if (instance && include) {
      ModelClass._eagerLoad([instance], include);
    }
    return instance;
  }

  /**
   * Permanently delete this instance, bypassing soft delete.
   */
  forceDelete(): boolean {
    const ModelClass = this.constructor as typeof BaseModel;
    const db = ModelClass.getDb();
    const pk = ModelClass.getPkField();
    const pkCol = ModelClass.getPkColumn();
    const pkValue = this[pk];

    if (pkValue === undefined || pkValue === null) {
      throw new Error("Cannot delete a model without a primary key value");
    }

    db.startTransaction();
    try {
      db.execute(
        `DELETE FROM "${ModelClass.tableName}" WHERE "${pkCol}" = ?`,
        [pkValue],
      );
      db.commit();
    } catch (e) {
      db.rollback();
      throw e;
    }
    return true;
  }

  /**
   * Restore a soft-deleted record.
   */
  restore(): boolean {
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

    db.startTransaction();
    try {
      db.execute(
        `UPDATE "${ModelClass.tableName}" SET is_deleted = 0 WHERE "${pkCol}" = ?`,
        [pkValue],
      );
      db.commit();
    } catch (e) {
      db.rollback();
      throw e;
    }
    this.is_deleted = 0;
    return true;
  }

  /**
   * Find records including soft-deleted ones.
   */
  static withTrashed<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    conditions?: string,
    params?: unknown[],
    limit?: number,
    offset?: number,
  ): T[] {
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

    const rows = db.query(sql, params);
    return rows.map((row) => new ModelClass(row as Record<string, unknown>) as T);
  }

  /**
   * Count records matching conditions (respects soft delete and table filter).
   */
  static count(conditions?: string, params?: unknown[]): number {
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
    const rows = db.query(sql, params);
    return rows.length > 0 ? (rows[0] as any).cnt : 0;
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
    (ModelClass as any)[name] = (limit: number = 20, offset: number = 0) => {
      return ModelClass.where.call(ModelClass as any, filterSql, params, limit, offset);
    };
  }

  /**
   * Load a has-one related model instance.
   */
  hasOne<T extends BaseModel, R extends BaseModel>(
    this: T,
    relatedClass: typeof BaseModel & (new (data?: Record<string, unknown>) => R),
    foreignKey: string,
  ): R | null {
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

    const rows = db.query(sql, [pkValue]);
    if (rows.length === 0) return null;

    const related = new relatedClass(rows[0] as Record<string, unknown>) as R;
    const relKey = relatedClass.tableName.toLowerCase();
    this[relKey] = related;
    return related;
  }

  /**
   * Load has-many related model instances.
   */
  hasMany<T extends BaseModel, R extends BaseModel>(
    this: T,
    relatedClass: typeof BaseModel & (new (data?: Record<string, unknown>) => R),
    foreignKey: string,
    limit: number = 100,
    offset: number = 0,
  ): R[] {
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

    const rows = db.query(sql, [pkValue]);
    const related = rows.map((row) => new relatedClass(row as Record<string, unknown>) as R);
    const relKey = relatedClass.tableName.toLowerCase();
    this[relKey] = related;
    return related;
  }

  /**
   * Load the parent model this instance belongs to.
   */
  belongsTo<T extends BaseModel, R extends BaseModel>(
    this: T,
    relatedClass: typeof BaseModel & (new (data?: Record<string, unknown>) => R),
    foreignKey: string,
  ): R | null {
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

    const rows = db.query(sql, [fkValue]);
    if (rows.length === 0) return null;

    const related = new relatedClass(rows[0] as Record<string, unknown>) as R;
    const relKey = relatedClass.tableName.toLowerCase();
    this[relKey] = related;
    return related;
  }

  /**
   * Register a model class for lookup by name (used by eager loading).
   */
  static _modelRegistry: Record<string, typeof BaseModel> = {};

  static registerModel(name: string, modelClass: typeof BaseModel): void {
    BaseModel._modelRegistry[name] = modelClass;
  }

  /**
   * Resolve a model class by name from the registry.
   */
  private static _resolveModel(name: string): (typeof BaseModel) | null {
    return BaseModel._modelRegistry[name] ?? null;
  }

  /**
   * Lazy-load a single relationship by name (used by toDict with include).
   */
  private _lazyLoadRelationship(relName: string): unknown {
    const ModelClass = this.constructor as typeof BaseModel;

    // Apply FK registry so foreignKey fields auto-wire relationships
    ModelClass._processForeignKeys();
    ModelClass._applyFkRegistry();

    // Check hasOne
    if (ModelClass.hasOne) {
      const rel = ModelClass.hasOne.find((r) => r.model.toLowerCase() === relName || r.model === relName);
      if (rel) {
        const relatedClass = BaseModel._modelRegistry[rel.model];
        if (relatedClass) {
          return this.hasOne(relatedClass as any, rel.foreignKey);
        }
      }
    }

    // Check hasMany
    if (ModelClass.hasMany) {
      const rel = ModelClass.hasMany.find((r) => {
        const base = r.model.toLowerCase();
        const key = _pluralRelKeys() ? base + "s" : base;
        return key === relName || base === relName || r.model === relName;
      });
      if (rel) {
        const relatedClass = BaseModel._modelRegistry[rel.model];
        if (relatedClass) {
          return this.hasMany(relatedClass as any, rel.foreignKey);
        }
      }
    }

    // Check belongsTo
    if (ModelClass.belongsTo) {
      const rel = ModelClass.belongsTo.find((r) => r.model.toLowerCase() === relName || r.model === relName);
      if (rel) {
        const relatedClass = BaseModel._modelRegistry[rel.model];
        if (relatedClass) {
          return this.belongsTo(relatedClass as any, rel.foreignKey);
        }
      }
    }

    return undefined;
  }

  /**
   * Eager load relationships for a collection of instances (prevents N+1).
   * @param instances Array of model instances.
   * @param include Array of relationship names (supports dot notation for nesting).
   */
  static _eagerLoad(instances: BaseModel[], include: string[]): void {
    if (instances.length === 0) return;

    const ModelClass = instances[0].constructor as typeof BaseModel;

    // Apply FK registry so foreignKey fields auto-wire hasMany on referenced models
    ModelClass._processForeignKeys();
    ModelClass._applyFkRegistry();

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
      // Find the relationship definition
      let relDef: RelationshipDefinition | undefined;
      let relType: "hasOne" | "hasMany" | "belongsTo" | null = null;

      if (ModelClass.hasOne) {
        relDef = ModelClass.hasOne.find((r) => r.model.toLowerCase() === relName || r.model === relName);
        if (relDef) relType = "hasOne";
      }
      if (!relDef && ModelClass.hasMany) {
        relDef = ModelClass.hasMany.find((r) => {
          const base = r.model.toLowerCase();
          const key = _pluralRelKeys() ? base + "s" : base;
          return key === relName || base === relName || r.model === relName;
        });
        if (relDef) relType = "hasMany";
      }
      if (!relDef && ModelClass.belongsTo) {
        relDef = ModelClass.belongsTo.find((r) => r.model.toLowerCase() === relName || r.model === relName);
        if (relDef) relType = "belongsTo";
      }

      if (!relDef || !relType) continue;

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

        const rows = db.query(sql, pkValues);
        const related = rows.map((row) => new relatedClass(row as Record<string, unknown>));

        // Eager load nested
        if (nested.length > 0 && related.length > 0) {
          relatedClass._eagerLoad(related, nested);
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

        const rows = db.query(sql, fkValues);
        const related = rows.map((row) => new relatedClass(row as Record<string, unknown>));

        if (nested.length > 0 && related.length > 0) {
          relatedClass._eagerLoad(related, nested);
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
  static eagerLoad(instances: BaseModel[], includeList: string[]): Promise<void> {
    const ModelClass = this as unknown as typeof BaseModel;
    ModelClass._eagerLoad(instances, includeList);
    return Promise.resolve();
  }

  /**
   * Clear the relationship cache.
   */
  clearRelCache(): void {
    this._relCache = {};
  }
}
