// Tina4 Seeder — seed database tables and ORM models with fake data.
// Zero external dependencies.

import { FakeData } from "./fakeData.js";
import type { DatabaseAdapter, FieldDefinition } from "./types.js";

/**
 * Seed a database table with fake data using raw SQL inserts.
 *
 * @param db - A DatabaseAdapter instance
 * @param tableName - The table to insert into
 * @param count - Number of rows to insert (default 10)
 * @param fieldMap - Dict of column_name -> callable that generates a value.
 *                   If not provided, no rows are inserted.
 * @param overrides - Static values applied to every row (overrides fieldMap)
 * @returns Number of rows inserted
 *
 * @example
 *   const fake = new FakeData();
 *   await seedTable(db, "users", 50, {
 *     name: () => fake.name(),
 *     email: () => fake.email(),
 *   });
 */
export async function seedTable(
  db: DatabaseAdapter,
  tableName: string,
  count = 10,
  fieldMap?: Record<string, (() => unknown) | unknown>,
  overrides?: Record<string, unknown>,
): Promise<number> {
  if (!fieldMap || Object.keys(fieldMap).length === 0) {
    return 0;
  }

  for (let i = 0; i < count; i++) {
    const row: Record<string, unknown> = {};

    // Generate values from fieldMap
    for (const [col, generator] of Object.entries(fieldMap)) {
      row[col] = typeof generator === "function" ? (generator as () => unknown)() : generator;
    }

    // Apply static overrides
    if (overrides) {
      for (const [col, value] of Object.entries(overrides)) {
        row[col] = value;
      }
    }

    // Build INSERT SQL
    const columns = Object.keys(row);
    const colList = columns.map((c) => `"${c}"`).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const values = columns.map((c) => row[c]);

    db.execute(
      `INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders})`,
      values,
    );
  }

  return count;
}

/**
 * Seed an ORM model class with fake data, auto-generating values
 * based on field definitions.
 *
 * @param ormClass - A model class with static `tableName`, `fields`, and optionally `_db`
 * @param count - Number of rows to insert (default 10)
 * @param overrides - Static values applied to every row (override auto-generated)
 * @param seed - Optional PRNG seed for deterministic output
 * @returns Number of rows inserted
 *
 * @example
 *   import User from "./src/models/User.js";
 *   await seedOrm(User, 100, { role: "user" });
 */
export async function seedOrm(
  ormClass: {
    tableName: string;
    fields: Record<string, FieldDefinition>;
    _db?: string;
    getDb?: () => DatabaseAdapter;
  },
  count = 10,
  overrides?: Record<string, unknown>,
  seed?: number,
): Promise<number> {
  const fake = new FakeData(seed);
  const fields = ormClass.fields;

  // Build a fieldMap from the model's field definitions
  const fieldMap: Record<string, () => unknown> = {};

  for (const [colName, fieldDef] of Object.entries(fields)) {
    // Skip auto-increment primary keys
    if (fieldDef.primaryKey && fieldDef.autoIncrement) {
      continue;
    }
    // Skip fields that have an override
    if (overrides && colName in overrides) {
      continue;
    }
    fieldMap[colName] = () => fake.forField(fieldDef, colName);
  }

  // Get the database adapter — try the model's own getDb, then fall back to import
  let db: DatabaseAdapter;
  if (typeof (ormClass as any).getDb === "function") {
    db = (ormClass as any).getDb();
  } else {
    // Dynamic import to avoid circular dependency issues
    const { getAdapter, getNamedAdapter } = await import("./database.js");
    db = ormClass._db ? getNamedAdapter(ormClass._db) : getAdapter();
  }

  return seedTable(db, ormClass.tableName, count, fieldMap, overrides);
}
