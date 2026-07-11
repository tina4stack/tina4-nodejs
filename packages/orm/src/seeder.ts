// Tina4 Seeder — seed database tables and ORM models with fake data.
// Zero external dependencies.
//
// SEEDING FULL OVERHAUL (P1-P4) — unified, visible-but-resilient error
// handling. Mirrors the Python master (tina4_python/seeder/__init__.py):
//   - P1: each row is wrapped; a row failure is LOGGED (index + cause) and
//         skipped, incrementing `failed` — never silent (PHP/Ruby's old bug),
//         never fragile (the old Node crash now that adapterExecute() raises).
//         `strict: true` re-raises on the FIRST failure instead of skipping.
//   - P2: `clear: true` truncates the target before seeding (idempotent re-runs).
//   - P3: `seed` seeds the FakeData RNG for reproducible runs.
//   - P4: seedModels() topo-sorts by the ORM ForeignKeyField dependency graph
//         (parents before children, reverse-order clear), resolves FK values to
//         real parent PKs, and warns on clear type mismatches.

import { FakeData } from "./fakeData.js";
import { adapterExecute, adapterFetch, adapterColumns } from "./database.js";
import { Log } from "../../core/src/index.js";
import type { DatabaseAdapter, FieldDefinition, FieldType } from "./types.js";

/**
 * Result of a seed run — `{ seeded, failed, errors }`.
 *
 * `errors` is a list of `{ row, message }` describing every skipped row
 * (`row` is the 0-based index). Mirrors the Python `SeedSummary`; Node tests
 * compare `.seeded` / `.failed` rather than the bare integer.
 */
export interface SeedSummary {
  seeded: number;
  failed: number;
  errors: Array<{ row: number; message: string }>;
}

/** Options shared by seedTable / seedOrm / seedModels. */
export interface SeedOptions {
  /** Static values applied to every row (overrides generated values). */
  overrides?: Record<string, unknown>;
  /** Delete every existing row in the target before seeding (P2). */
  clear?: boolean;
  /** PRNG seed for reproducible FakeData output (P3). */
  seed?: number;
  /** Re-raise on the first failed row instead of skipping it (P1). */
  strict?: boolean;
}

/**
 * Normalise the legacy positional `overrides` argument and the new options
 * object into a single SeedOptions. Backward compatible: callers passing a
 * plain overrides object as the 5th positional arg still work.
 */
function normaliseOptions(
  overrides?: Record<string, unknown>,
  opts?: SeedOptions,
): Required<Pick<SeedOptions, "clear" | "strict">> & { overrides?: Record<string, unknown>; seed?: number } {
  const merged: SeedOptions = { ...(opts ?? {}) };
  // The new `opts.overrides` takes precedence if both are supplied.
  const effectiveOverrides = merged.overrides ?? overrides;
  return {
    overrides: effectiveOverrides,
    clear: merged.clear ?? false,
    seed: merged.seed,
    strict: merged.strict ?? false,
  };
}

/**
 * Delete every row in `table`. Tolerant — logs and continues on error so the
 * summary itself never crashes (mirrors Python `_clear_table`).
 */
async function clearTable(db: DatabaseAdapter, tableName: string): Promise<void> {
  try {
    await adapterExecute(db, `DELETE FROM "${tableName}"`);
  } catch (e) {
    Log.warning(`Seeder: could not clear '${tableName}': ${(e as Error).message}`);
  }
}

/**
 * Map a raw SQL column type string to a Tina4 FieldType so FakeData.forField()
 * can pick a generator. Substring match (case-insensitive) covers the engine
 * spellings — INTEGER/INT, REAL/FLOAT/DOUBLE/NUMERIC/DECIMAL, BOOL, DATE/TIME,
 * TEXT/CLOB. Anything else is a plain string.
 */
function sqlTypeToFieldType(sqlType: string): FieldType {
  const t = (sqlType || "").toUpperCase();
  if (t.includes("INT")) return "integer";
  if (t.includes("BOOL")) return "boolean";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB") || t.includes("NUM") || t.includes("DEC")) return "number";
  if (t.includes("DATE") || t.includes("TIME")) return "datetime";
  if (t.includes("TEXT") || t.includes("CLOB")) return "text";
  return "string";
}

/**
 * Introspect `table`'s columns and build a column->generator field map for
 * {@link seedTable}, skipping the auto-increment / `id` primary key (the engine
 * assigns it). Mirrors the Python master's `auto_field_map`
 * (tina4_python/seeder/__init__.py): the shared "seed a table I did not
 * hand-write generators for" helper that both the dev-admin seed endpoint and
 * the MCP `seed_table` dev tool use — `seedTable` itself stays explicit
 * (no map = no rows), and this is how a caller opts into automatic generation.
 *
 * Reuses `FakeData.forField()` (column-name + type heuristics) so the generated
 * data matches every other Tina4 seeding path. Returns an empty map when the
 * table has no seedable columns, so `seedTable` then seeds nothing rather than
 * crashing.
 *
 * @param db - A DatabaseAdapter instance (pass `getAdapter()`, NOT the Database
 *             wrapper — the wrapper has no `columns()`).
 * @param table - The table to introspect.
 * @param fake - Optional shared FakeData (pass one seeded via `new FakeData(n)`
 *               for reproducible output).
 * @returns `{ column -> () => value }`, ready to hand to `seedTable`.
 */
export async function autoFieldMap(
  db: DatabaseAdapter,
  table: string,
  fake: FakeData = new FakeData(),
): Promise<Record<string, () => unknown>> {
  const columns = await adapterColumns(db, table);
  const fieldMap: Record<string, () => unknown> = {};
  for (const col of columns) {
    const name = col.name;
    const sqlType = String(col.type ?? "").toUpperCase();
    // Skip the auto-increment surrogate key so the INSERT omits it and the
    // engine assigns it. Mirrors Python: primary key AND (AUTO/SERIAL/IDENTITY
    // in the type OR the column is literally `id` — SQLite reports just
    // "INTEGER" for an AUTOINCREMENT rowid alias, so the name catch is needed).
    if (col.primaryKey === true &&
        (sqlType.includes("AUTO") || sqlType.includes("SERIAL") ||
         sqlType.includes("IDENTITY") || name.toLowerCase() === "id")) {
      continue;
    }
    const fieldType = sqlTypeToFieldType(sqlType);
    // Bind the type + name per column; forField applies the name heuristics
    // (email/phone/name/...) before falling back to the type.
    fieldMap[name] = () => fake.forField({ type: fieldType }, name);
  }
  return fieldMap;
}

/**
 * Seed a database table with fake data using raw SQL inserts.
 *
 * Visible-but-resilient (P1): each row is wrapped. On a row failure the cause
 * is logged (with the row index) and the row is skipped — unless `strict: true`,
 * in which case the first failure RE-RAISES. At the end a one-line summary is
 * logged ("seeded N, M failed").
 *
 * @param db - A DatabaseAdapter instance
 * @param tableName - The table to insert into
 * @param count - Number of rows to insert (default 10)
 * @param fieldMap - Dict of column_name -> callable that generates a value
 *                   (or a static value). If not provided, no rows are inserted.
 * @param overrides - (legacy positional) Static values applied to every row.
 *                   Prefer `opts.overrides`.
 * @param opts - Seed options: `{ overrides, clear, seed, strict }`.
 * @returns A SeedSummary `{ seeded, failed, errors }`.
 *
 * @example
 *   const fake = new FakeData();
 *   await seedTable(db, "users", 50, {
 *     name: () => fake.name(),
 *     email: () => fake.email(),
 *   }, undefined, { clear: true });
 */
export async function seedTable(
  db: DatabaseAdapter,
  tableName: string,
  count = 10,
  fieldMap?: Record<string, (() => unknown) | unknown>,
  overrides?: Record<string, unknown>,
  opts?: SeedOptions,
): Promise<SeedSummary> {
  const { overrides: effectiveOverrides, clear, strict } = normaliseOptions(overrides, opts);

  if (!fieldMap || Object.keys(fieldMap).length === 0) {
    return { seeded: 0, failed: 0, errors: [] };
  }

  if (clear) {
    await clearTable(db, tableName);
  }

  let seeded = 0;
  let failed = 0;
  const errors: Array<{ row: number; message: string }> = [];

  for (let i = 0; i < count; i++) {
    try {
      const row: Record<string, unknown> = {};

      // Generate values from fieldMap
      for (const [col, generator] of Object.entries(fieldMap)) {
        row[col] = typeof generator === "function" ? (generator as () => unknown)() : generator;
      }

      // Apply static overrides
      if (effectiveOverrides) {
        for (const [col, value] of Object.entries(effectiveOverrides)) {
          row[col] = value;
        }
      }

      // Build INSERT SQL
      const columns = Object.keys(row);
      const colList = columns.map((c) => `"${c}"`).join(", ");
      const placeholders = columns.map(() => "?").join(", ");
      const values = columns.map((c) => row[c]);

      // adapterExecute() RAISES on a constraint/SQL error since v3.13.x — the
      // try/except is what turns that into a counted, logged, skipped failure.
      await adapterExecute(
        db,
        `INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders})`,
        values,
      );
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

/** A model-like shape the seeder can drive (real BaseModel subclass or mock). */
interface SeedableModel {
  tableName: string;
  fields: Record<string, FieldDefinition>;
  _db?: string;
  getDb?: () => DatabaseAdapter;
  name?: string;
}

/**
 * Resolve the DatabaseAdapter for a model — try its own getDb(), then fall
 * back to the bound adapters (default or named via `_db`).
 */
async function resolveModelDb(ormClass: SeedableModel): Promise<DatabaseAdapter> {
  if (typeof ormClass.getDb === "function") {
    return ormClass.getDb();
  }
  const { getAdapter, getNamedAdapter } = await import("./database.js");
  return ormClass._db ? getNamedAdapter(ormClass._db) : getAdapter();
}

/**
 * P4c — when a generated value's JS type clearly mismatches the target column's
 * field type, LOG a warning (never hard-fail). Mirrors Python `_validate_types`.
 */
function validateTypes(
  fields: Record<string, FieldDefinition>,
  attrs: Record<string, unknown>,
  modelName: string,
): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    const field = fields[name];
    if (!field) continue;
    const t = field.type;
    let expected: string | null = null;
    if (t === "integer" || t === "foreignKey") expected = "number";
    else if (t === "number" || t === "numeric") expected = "number";
    else if (t === "boolean") expected = "boolean";
    if (expected === null) continue;
    // booleans are acceptable in numeric columns; don't warn on that.
    if (expected === "number" && typeof value === "boolean") continue;
    if (typeof value !== expected) {
      Log.warning(
        `Seeder: ${modelName}.${name} expected ${expected} but generated ` +
          `${typeof value} (${JSON.stringify(value)}) — inserting anyway`,
      );
    }
  }
}

/**
 * P4a — for each foreignKey field on the model, fetch the existing primary-key
 * values of the referenced table so seeded child rows reference a REAL parent
 * (parents are seeded first by seedModels's topo order). Returns
 * `{ fkFieldName: [pkValue, ...] }`; columns with no resolvable / empty parent
 * are omitted (the generic generator then fills them, and the row may fail
 * loudly — never silently). Mirrors Python `_foreign_key_pools`.
 */
async function foreignKeyPools(
  db: DatabaseAdapter,
  fields: Record<string, FieldDefinition>,
  resolveModel: (name: string) => SeedableModel | null,
): Promise<Record<string, unknown[]>> {
  const pools: Record<string, unknown[]> = {};
  for (const [name, def] of Object.entries(fields)) {
    if (def.type !== "foreignKey" || !def.references) continue;
    try {
      const target = resolveModel(def.references);
      if (!target) continue;
      const pk = pkFieldOf(target.fields);
      const rows = await adapterFetch<Record<string, unknown>>(
        db,
        `SELECT "${pk}" FROM "${target.tableName}"`,
      );
      const values = rows
        .map((r) => r[pk])
        .filter((v) => v !== null && v !== undefined);
      if (values.length > 0) {
        pools[name] = values;
      }
    } catch (e) {
      Log.warning(`Seeder: could not resolve FK pool for ${name}: ${(e as Error).message}`);
    }
  }
  return pools;
}

/** The primary-key field name from a fields map (defaults to "id"). */
function pkFieldOf(fields: Record<string, FieldDefinition>): string {
  for (const [name, def] of Object.entries(fields)) {
    if (def.primaryKey) return name;
  }
  return "id";
}

/**
 * Seed an ORM model class with auto-generated fake data, based on field
 * definitions. Visible-but-resilient (P1): each row is wrapped, failures are
 * logged + counted + skipped (or re-raised under `strict`).
 *
 * @param ormClass - A model with static `tableName`, `fields`, and optionally
 *   `getDb`/`_db`.
 * @param count - Number of rows to insert (default 10)
 * @param overrides - (legacy positional) Static field overrides.
 * @param seed - (legacy positional) PRNG seed for deterministic output.
 * @param opts - Seed options `{ overrides, clear, seed, strict }`. Options
 *   supersede the legacy positional args when both are supplied.
 * @param fkPools - (internal) pre-resolved FK value pools from seedModels.
 * @returns A SeedSummary `{ seeded, failed, errors }`.
 */
export async function seedOrm(
  ormClass: SeedableModel,
  count = 10,
  overrides?: Record<string, unknown>,
  seed?: number,
  opts?: SeedOptions,
  fkPools?: Record<string, unknown[]>,
): Promise<SeedSummary> {
  const merged: SeedOptions = { ...(opts ?? {}) };
  const effectiveOverrides = merged.overrides ?? overrides;
  const effectiveSeed = merged.seed ?? seed;
  const clear = merged.clear ?? false;
  const strict = merged.strict ?? false;

  const fake = new FakeData(effectiveSeed);
  const fields = ormClass.fields ?? {};
  const modelName = ormClass.name ?? ormClass.tableName;

  if (Object.keys(fields).length === 0) {
    Log.error(`Seeder: No fields found on ${modelName}`);
    return { seeded: 0, failed: 0, errors: [] };
  }

  const db = await resolveModelDb(ormClass);

  if (clear) {
    await clearTable(db, ormClass.tableName);
  }

  // Auto-increment primary keys are never generated.
  const autoPk = new Set(
    Object.entries(fields)
      .filter(([, def]) => def.primaryKey && def.autoIncrement)
      .map(([name]) => name),
  );

  // Resolve FK value pools when not supplied by seedModels (so a standalone
  // seedOrm of a child whose parents already exist still references real PKs).
  let pools = fkPools;
  if (pools === undefined) {
    const { getRegisteredModel } = await import("./baseModel.js").then((m) => ({
      getRegisteredModel: (name: string): SeedableModel | null =>
        (m.BaseModel as any)._modelRegistry?.[name] ?? null,
    }));
    pools = await foreignKeyPools(db, fields, getRegisteredModel);
  }

  let seeded = 0;
  let failed = 0;
  const errors: Array<{ row: number; message: string }> = [];

  for (let i = 0; i < count; i++) {
    try {
      const attrs: Record<string, unknown> = {};
      for (const [name, def] of Object.entries(fields)) {
        if (autoPk.has(name)) continue;
        if (effectiveOverrides && name in effectiveOverrides) {
          const val = effectiveOverrides[name];
          attrs[name] = typeof val === "function" ? (val as (f: FakeData) => unknown)(fake) : val;
        } else if (pools[name] && pools[name].length > 0) {
          attrs[name] = fake.choice(pools[name]);
        } else {
          attrs[name] = fake.forField(def, name);
        }
      }
      validateTypes(fields, attrs, modelName);

      const columns = Object.keys(attrs);
      const colList = columns.map((c) => `"${c}"`).join(", ");
      const placeholders = columns.map(() => "?").join(", ");
      const values = columns.map((c) => attrs[c]);

      await adapterExecute(
        db,
        `INSERT INTO "${ormClass.tableName}" (${colList}) VALUES (${placeholders})`,
        values,
      );
      seeded++;
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      if (strict) {
        Log.error(`Seeder: row ${i} failed seeding ${modelName} (strict): ${message}`);
        throw e;
      }
      failed++;
      errors.push({ row: i, message });
      Log.warning(`Seeder: row ${i} failed seeding ${modelName}, skipped: ${message}`);
    }
  }

  Log.info(`Seeder: ${modelName} — seeded ${seeded}, ${failed} failed`);
  return { seeded, failed, errors };
}

/**
 * Topologically sort ORM models so parents (referenced tables) come before
 * children (tables with a foreignKey pointing at them). Uses the ORM's existing
 * `references` metadata. Models not in the input list are ignored as
 * dependencies (you only seed what you pass). Cycles / unresolved deps fall
 * back to the caller's declared order so nothing is dropped. Mirrors Python
 * `_topo_sort_models`.
 */
function topoSortModels(ormClasses: SeedableModel[]): SeedableModel[] {
  const inSet: SeedableModel[] = [];
  for (const m of ormClasses) {
    if (!inSet.includes(m)) inSet.push(m);
  }
  const nameToModel = new Map<string, SeedableModel>();
  for (const m of inSet) {
    nameToModel.set(m.name ?? m.tableName, m);
  }

  const depsOf = (model: SeedableModel): Set<SeedableModel> => {
    const deps = new Set<SeedableModel>();
    for (const def of Object.values(model.fields ?? {})) {
      if (def.type === "foreignKey" && def.references) {
        const target = nameToModel.get(def.references);
        if (target && target !== model) deps.add(target);
      }
    }
    return deps;
  };

  const depsMap = new Map<SeedableModel, Set<SeedableModel>>();
  for (const m of inSet) depsMap.set(m, depsOf(m));

  const ordered: SeedableModel[] = [];
  const placed = new Set<SeedableModel>();
  let remaining = [...inSet];
  let progressed = true;
  while (remaining.length > 0 && progressed) {
    progressed = false;
    const still: SeedableModel[] = [];
    for (const model of remaining) {
      const deps = depsMap.get(model)!;
      let allPlaced = true;
      for (const d of deps) {
        if (!placed.has(d)) { allPlaced = false; break; }
      }
      if (allPlaced) {
        ordered.push(model);
        placed.add(model);
        progressed = true;
      } else {
        still.push(model);
      }
    }
    remaining = still;
  }
  // Cycle / unresolved deps — append in declared order so we never drop a model.
  ordered.push(...remaining);
  return ordered;
}

/**
 * Batch-seed several ORM models, ordering by their foreignKey dependency graph
 * (P4a). Parent tables seed before children (topological sort); when
 * `clear: true` the clear runs in REVERSE order so children are removed before
 * parents — no FK violations regardless of the order the caller lists models.
 * FK columns are resolved to real parent PKs so child rows reference an
 * existing parent. Mirrors Python `seed_models`.
 *
 * @param ormClasses - List of model classes to seed.
 * @param count - Rows per model (default 10).
 * @param opts - Seed options. `overrides` may be a flat dict applied to every
 *   model, or a Map/record keyed by model to apply per-model overrides.
 * @returns `{ [modelName]: SeedSummary }` for each model seeded.
 */
export async function seedModels(
  ormClasses: SeedableModel[],
  count = 10,
  opts?: SeedOptions & { overrides?: Record<string, unknown> | Map<SeedableModel, Record<string, unknown>> },
): Promise<Record<string, SeedSummary>> {
  const clear = opts?.clear ?? false;
  const seed = opts?.seed;
  const strict = opts?.strict ?? false;
  const overrides = opts?.overrides;

  const ordered = topoSortModels(ormClasses);

  // Build a name→model resolver covering the input set so FK pools resolve
  // even when the referenced model isn't in BaseModel's global registry.
  const nameToModel = new Map<string, SeedableModel>();
  for (const m of ordered) nameToModel.set(m.name ?? m.tableName, m);
  const resolveModel = (name: string): SeedableModel | null => nameToModel.get(name) ?? null;

  if (clear) {
    for (let i = ordered.length - 1; i >= 0; i--) {
      const model = ordered[i];
      const db = await resolveModelDb(model);
      await clearTable(db, model.tableName);
    }
  }

  const results: Record<string, SeedSummary> = {};
  for (const model of ordered) {
    const db = await resolveModelDb(model);
    const pools = await foreignKeyPools(db, model.fields ?? {}, resolveModel);

    let modelOverrides: Record<string, unknown> | undefined;
    if (overrides instanceof Map) {
      modelOverrides = overrides.get(model);
    } else {
      modelOverrides = overrides as Record<string, unknown> | undefined;
    }

    const summary = await seedOrm(
      model,
      count,
      undefined,
      undefined,
      { overrides: modelOverrides, clear: false, seed, strict },
      pools,
    );
    results[model.name ?? model.tableName] = summary;
  }
  return results;
}
