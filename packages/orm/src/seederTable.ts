import { FakeData } from "./fakeData.js";
import { adapterExecute, adapterColumns, adapterInsert } from "./database.js";
import { Log } from "../../core/src/index.js";
import type { DatabaseAdapter, FieldDefinition, FieldType } from "./types.js";
import type { SeedOptions, SeedSummary } from "./seederTypes.js";

function normaliseOptions(overrides?: Record<string, unknown>, opts?: SeedOptions):
  Required<Pick<SeedOptions, "clear" | "strict">> & { overrides?: Record<string, unknown> } {
  const merged = { ...(opts ?? {}) };
  return {
    overrides: merged.overrides ?? overrides,
    clear: merged.clear ?? false,
    strict: merged.strict ?? false,
  };
}

/** Delete every row, logging but not hiding a clear failure. */
export async function clearTable(db: DatabaseAdapter, tableName: string): Promise<void> {
  try {
    await adapterExecute(db, `DELETE FROM "${tableName}"`);
  } catch (e) {
    Log.warning(`Seeder: could not clear '${tableName}': ${(e as Error).message}`);
  }
}

function sqlTypeToFieldType(sqlType: string): FieldType {
  const type = (sqlType || "").toUpperCase();
  if (type.includes("INT")) return "integer";
  if (type.includes("BOOL")) return "boolean";
  if (["REAL", "FLOA", "DOUB", "NUM", "DEC"].some((part) => type.includes(part))) return "number";
  if (type.includes("DATE") || type.includes("TIME")) return "datetime";
  if (type.includes("TEXT") || type.includes("CLOB")) return "text";
  return "string";
}

/** Build generators from live table metadata for the explicit seedTable path. */
export async function autoFieldMap(
  db: DatabaseAdapter,
  table: string,
  fake: FakeData = new FakeData(),
): Promise<Record<string, () => unknown>> {
  const columns = await adapterColumns(db, table);
  const fieldMap: Record<string, () => unknown> = {};
  for (const column of columns) {
    const name = column.name;
    const sqlType = String(column.type ?? "").toUpperCase();
    const generatedPk = column.primaryKey === true &&
      (sqlType.includes("AUTO") || sqlType.includes("SERIAL") || sqlType.includes("IDENTITY") || name.toLowerCase() === "id");
    if (generatedPk) continue;
    fieldMap[name] = () => fake.forField({ type: sqlTypeToFieldType(sqlType) }, name, table);
  }
  return fieldMap;
}

/** Seed a table through the adapter insert path, counting or re-raising row failures. */
export async function seedTable(
  db: DatabaseAdapter,
  tableName: string,
  count = 10,
  fieldMap?: Record<string, (() => unknown) | unknown>,
  overrides?: Record<string, unknown>,
  opts?: SeedOptions,
): Promise<SeedSummary> {
  if (opts?.seed !== undefined) {
    throw new Error(
      "seedTable() no longer accepts opts.seed: it has no generators of its own to seed " +
      "(fieldMap callables are opaque). Build a seeded FakeData yourself and close over it " +
      "in fieldMap, e.g. const fake = new FakeData(42); seedTable(db, table, count, " +
      "{ name: () => fake.name() }).",
    );
  }
  const { overrides: effectiveOverrides, clear, strict } = normaliseOptions(overrides, opts);
  if (!fieldMap || Object.keys(fieldMap).length === 0) return { seeded: 0, failed: 0, errors: [] };
  if (clear) await clearTable(db, tableName);

  let seeded = 0;
  let failed = 0;
  const errors: Array<{ row: number; message: string }> = [];
  for (let i = 0; i < count; i++) {
    try {
      const row: Record<string, unknown> = {};
      for (const [column, generator] of Object.entries(fieldMap)) {
        row[column] = typeof generator === "function" ? (generator as () => unknown)() : generator;
      }
      for (const [column, value] of Object.entries(effectiveOverrides ?? {})) row[column] = value;
      await adapterInsert(db, tableName, row);
      seeded++;
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      if (strict) {
        Log.error(`Seeder: row ${i} failed seeding '${tableName}' (strict): ${message}`);
        throw e;
      }
      failed++;
      errors.push({ row: i, message });
      Log.warning(`Seeder: row ${i} failed seeding '${tableName}', skipped: ${message}`);
    }
  }
  Log.info(`Seeder: '${tableName}' — seeded ${seeded}, ${failed} failed`);
  return { seeded, failed, errors };
}
