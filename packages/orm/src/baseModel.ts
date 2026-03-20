import { getAdapter, getNamedAdapter } from "./database.js";
import { validate as validateFields } from "./validation.js";
import type { DatabaseAdapter, FieldDefinition, RelationshipDefinition } from "./types.js";

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
 *   }
 */
export class BaseModel {
  static tableName: string;
  static fields: Record<string, FieldDefinition>;
  static softDelete?: boolean;
  static tableFilter?: string;
  static hasOne?: RelationshipDefinition[];
  static hasMany?: RelationshipDefinition[];
  static _db?: string;

  /** Instance data */
  [key: string]: unknown;

  constructor(data?: Record<string, unknown>) {
    if (data) {
      for (const [key, value] of Object.entries(data)) {
        this[key] = value;
      }
    }
  }

  /**
   * Get the database adapter for this model.
   */
  protected static getDb(): DatabaseAdapter {
    if (this._db) {
      return getNamedAdapter(this._db);
    }
    return getAdapter();
  }

  /**
   * Get the primary key field name.
   */
  protected static getPkField(): string {
    return Object.entries(this.fields).find(([, def]) => def.primaryKey)?.[0] ?? "id";
  }

  /**
   * Find a record by primary key.
   */
  static findById<T extends BaseModel>(this: new (data?: Record<string, unknown>) => T, id: unknown): T | null {
    const ModelClass = this as unknown as typeof BaseModel & (new (data?: Record<string, unknown>) => T);
    const db = ModelClass.getDb();
    const pk = ModelClass.getPkField();
    let sql = `SELECT * FROM "${ModelClass.tableName}" WHERE "${pk}" = ?`;

    if (ModelClass.softDelete) {
      sql += ` AND is_deleted = 0`;
    }
    if (ModelClass.tableFilter) {
      sql += ` AND ${ModelClass.tableFilter}`;
    }

    const rows = db.query(sql, [id]);
    if (rows.length === 0) return null;
    return new ModelClass(rows[0] as Record<string, unknown>) as T;
  }

  /**
   * Find all records, optionally with a where clause.
   */
  static findAll<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    where?: string,
    params?: unknown[],
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
    const sql = `SELECT * FROM "${ModelClass.tableName}"${whereClause}`;

    const rows = db.query(sql, params);
    return rows.map((row) => new ModelClass(row as Record<string, unknown>) as T);
  }

  /**
   * Save this instance (insert or update).
   */
  save(): void {
    const ModelClass = this.constructor as typeof BaseModel;
    const db = ModelClass.getDb();
    const pk = ModelClass.getPkField();
    const pkValue = this[pk];

    if (pkValue !== undefined && pkValue !== null) {
      // Update
      const updateFields = Object.entries(ModelClass.fields).filter(
        ([name, def]) => !def.primaryKey && this[name] !== undefined,
      );
      if (updateFields.length === 0) return;

      const setClause = updateFields.map(([k]) => `"${k}" = ?`).join(", ");
      const values = [...updateFields.map(([k]) => this[k]), pkValue];

      db.execute(`UPDATE "${ModelClass.tableName}" SET ${setClause} WHERE "${pk}" = ?`, values);
    } else {
      // Insert
      const insertFields = Object.entries(ModelClass.fields).filter(
        ([name, def]) => !(def.primaryKey && def.autoIncrement) && this[name] !== undefined,
      );

      const columns = insertFields.map(([k]) => `"${k}"`).join(", ");
      const placeholders = insertFields.map(() => "?").join(", ");
      const values = insertFields.map(([k]) => this[k]);

      const result = db.execute(
        `INSERT INTO "${ModelClass.tableName}" (${columns}) VALUES (${placeholders})`,
        values,
      ) as { lastInsertRowid?: number };

      if (result.lastInsertRowid) {
        this[pk] = result.lastInsertRowid;
      }
    }
  }

  /**
   * Delete this instance. Uses soft delete if configured.
   */
  delete(): void {
    const ModelClass = this.constructor as typeof BaseModel;
    const db = ModelClass.getDb();
    const pk = ModelClass.getPkField();
    const pkValue = this[pk];

    if (pkValue === undefined || pkValue === null) {
      throw new Error("Cannot delete a model without a primary key value");
    }

    if (ModelClass.softDelete) {
      db.execute(
        `UPDATE "${ModelClass.tableName}" SET is_deleted = 1 WHERE "${pk}" = ?`,
        [pkValue],
      );
      this.is_deleted = 1;
    } else {
      db.execute(
        `DELETE FROM "${ModelClass.tableName}" WHERE "${pk}" = ?`,
        [pkValue],
      );
    }
  }

  /**
   * Convert to plain object (dictionary).
   */
  toDict(): Record<string, unknown> {
    const ModelClass = this.constructor as typeof BaseModel;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(ModelClass.fields)) {
      if (this[key] !== undefined) {
        result[key] = this[key];
      }
    }
    // Include relationship data
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
        const relKey = rel.model.toLowerCase() + "s";
        if (this[relKey] !== undefined) {
          result[relKey] = this[relKey];
        }
      }
    }
    // Include soft delete field
    if (ModelClass.softDelete && this.is_deleted !== undefined) {
      result.is_deleted = this.is_deleted;
    }
    return result;
  }

  /**
   * Convert to a plain object (alias for toDict).
   */
  toObject(): Record<string, unknown> {
    return this.toDict();
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
   */
  toJson(): string {
    return JSON.stringify(this.toDict());
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

  /**
   * Permanently delete this instance, bypassing soft delete.
   */
  forceDelete(): void {
    const ModelClass = this.constructor as typeof BaseModel;
    const db = ModelClass.getDb();
    const pk = ModelClass.getPkField();
    const pkValue = this[pk];

    if (pkValue === undefined || pkValue === null) {
      throw new Error("Cannot delete a model without a primary key value");
    }

    db.execute(
      `DELETE FROM "${ModelClass.tableName}" WHERE "${pk}" = ?`,
      [pkValue],
    );
  }

  /**
   * Restore a soft-deleted record.
   */
  restore(): void {
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

    db.execute(
      `UPDATE "${ModelClass.tableName}" SET is_deleted = 0 WHERE "${pk}" = ?`,
      [pkValue],
    );
    this.is_deleted = 0;
  }

  /**
   * Find records including soft-deleted ones.
   */
  static withTrashed<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    conditions?: string,
    params?: unknown[],
    limit?: number,
    skip?: number,
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
    if (skip !== undefined) {
      sql += ` OFFSET ${skip}`;
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
   * Apply a named scope (reusable query filter).
   */
  static scope<T extends BaseModel>(
    this: new (data?: Record<string, unknown>) => T,
    name: string,
    filterSql: string,
    params?: unknown[],
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
    conditions.push(filterSql);

    const sql = `SELECT * FROM "${ModelClass.tableName}" WHERE ${conditions.join(" AND ")}`;
    const rows = db.query(sql, params);
    return rows.map((row) => new ModelClass(row as Record<string, unknown>) as T);
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
    const fkValue = this[foreignKey];

    if (fkValue === undefined || fkValue === null) {
      return null;
    }

    const db = relatedClass.getDb();
    const relatedPk = relatedClass.getPkField();
    let sql = `SELECT * FROM "${relatedClass.tableName}" WHERE "${relatedPk}" = ?`;
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
}
