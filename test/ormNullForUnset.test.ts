/**
 * #165 — an INSERT must OMIT a column the caller never assigned so a
 * `NOT NULL DEFAULT <x>` column gets its DB default, while still writing NULL
 * for a field the caller explicitly set to null.
 *
 * Before the fix, a model with EVERY insertable column unset produced
 * `INSERT INTO <t> () VALUES ()` — invalid SQL on SQLite (`near ")": syntax
 * error`), so an all-defaults insert failed outright. The DB default of a
 * `NOT NULL DEFAULT ''` / `NOT NULL DEFAULT 0` column applies only when the
 * column is OMITTED, never when an explicit NULL is passed.
 *
 * The contract locked in here (positive AND negative), mirroring the Python
 * master (tina4-python tests/test_orm_null_for_unset.py):
 *   - a column left UNSET (undefined)  -> omitted -> DB default applies
 *   - a column set to null explicitly  -> written -> explicit NULL (fails NOT NULL)
 *   - a non-null ORM default           -> still written (no regression)
 *   - EVERY insertable column unset    -> engine all-defaults insert succeeds
 *
 * In TS, an unset column is `undefined` (the constructor only seeds a field
 * that declares a non-null ORM default), and an explicit null is `null` — the
 * runtime distinguishes them natively, doing the job Python's _assigned_fields
 * set does.
 *
 * NOT a mock: real node:sqlite Database, real DDL with real DEFAULT + NOT NULL
 * constraints, real save()/reload round-trips.
 * Run with: npx tsx test/ormNullForUnset.test.ts
 */
import { rmSync, mkdirSync } from "node:fs";
import { initDatabase, closeDatabase, BaseModel } from "../packages/orm/src/index.ts";
import type { FieldDefinition } from "../packages/orm/src/index.ts";

const DIR = "/tmp/tina4-orm-null-unset-165";
let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail = ""): void {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

try { rmSync(DIR, { recursive: true }); } catch { /* first run */ }
mkdirSync(DIR, { recursive: true });

console.log("=== ORM omit-unset-columns-on-INSERT (#165) ===\n");

// DDL owns the DEFAULT constraints the ORM must respect. label/quantity are
// NOT NULL DEFAULT; note is nullable (to show explicit-null -> NULL is accepted
// where the column allows it).
const db = await initDatabase({ type: "sqlite", path: `${DIR}/test.db` });
db.execute(`CREATE TABLE widget165 (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  label    TEXT    NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 0,
  note     TEXT
)`);

class Widget165 extends BaseModel {
  static tableName = "widget165";
  static fields: Record<string, FieldDefinition> = {
    id:       { type: "integer", primaryKey: true, autoIncrement: true },
    label:    { type: "string" },
    quantity: { type: "integer" },
    note:     { type: "string" },
  };
}
BaseModel.registerModel("Widget165", Widget165);

async function rowById(id: unknown): Promise<Record<string, unknown> | null> {
  return db.fetchOne(`SELECT * FROM widget165 WHERE id = ?`, [id]);
}

// ── Positive: all columns unset -> DB defaults (all-defaults insert path) ──
{
  const w = new Widget165();
  const saved = await w.save();
  assert("all columns unset: save() succeeds (all-defaults insert)", saved !== false, `err=${w.getError()}`);
  const row = await rowById((w as any).id);
  assert("all-unset: NOT NULL DEFAULT '' applied to unset label", row?.label === "", `got ${JSON.stringify(row)}`);
  assert("all-unset: NOT NULL DEFAULT 0 applied to unset quantity", row?.quantity === 0, `got ${JSON.stringify(row)}`);
  assert("all-unset: nullable note is NULL", row?.note === null, `got ${JSON.stringify(row?.note)}`);
}

// ── Positive: partial unset -> the unset column falls through to DB default ──
{
  const w = new Widget165({ label: "hello" });
  const saved = await w.save();
  assert("partial unset: save() succeeds", saved !== false, `err=${w.getError()}`);
  const row = await rowById((w as any).id);
  assert("partial unset: assigned label written", row?.label === "hello", `got ${JSON.stringify(row)}`);
  assert("partial unset: unset NOT NULL quantity uses DB default 0", row?.quantity === 0, `got ${JSON.stringify(row)}`);
}

// ── Positive: an assigned value is written verbatim ──
{
  const w = new Widget165({ label: "widget", quantity: 7 });
  const saved = await w.save();
  assert("assigned values: save() succeeds", saved !== false, `err=${w.getError()}`);
  const row = await rowById((w as any).id);
  assert("assigned values: label written", row?.label === "widget", `got ${JSON.stringify(row)}`);
  assert("assigned values: quantity written", row?.quantity === 7, `got ${JSON.stringify(row)}`);
}

// ── Positive: explicit null on a NULLABLE column persists NULL (not omitted) ──
{
  const w = new Widget165({ label: "x", note: null });
  const saved = await w.save();
  assert("explicit null on nullable: save() succeeds", saved !== false, `err=${w.getError()}`);
  const row = await rowById((w as any).id);
  assert("explicit null on nullable: note persisted as NULL", row?.note === null, `got ${JSON.stringify(row?.note)}`);
}

// ── Negative: explicit null via constructor IS written (as NULL), so a
//    NOT NULL column rejects it — save() fails loud and no row lands. ──
{
  const before = (await db.fetch(`SELECT * FROM widget165`)).count;
  const w = new Widget165({ label: "x", quantity: null });
  const saved = await w.save();
  assert("explicit null (ctor) on NOT NULL: save() returns false", saved === false, `got ${saved}`);
  assert("explicit null (ctor) on NOT NULL: error captured", w.getError() !== null);
  const after = (await db.fetch(`SELECT * FROM widget165`)).count;
  assert("explicit null (ctor) on NOT NULL: no row landed", after === before, `before=${before} after=${after}`);
}

// ── Negative: explicit null via post-construction attribute assignment is
//    written as NULL and rejected by the NOT NULL column (not omitted). ──
{
  const before = (await db.fetch(`SELECT * FROM widget165`)).count;
  const w = new Widget165({ label: "y" });
  (w as any).quantity = null; // explicit — must be written, not omitted
  const saved = await w.save();
  assert("explicit null (attr) on NOT NULL: save() returns false", saved === false, `got ${saved}`);
  const after = (await db.fetch(`SELECT * FROM widget165`)).count;
  assert("explicit null (attr) on NOT NULL: no row landed", after === before, `before=${before} after=${after}`);
}

// ── Regression guard: a non-null ORM default is still written (not omitted) ──
{
  class Widget165Defaulted extends BaseModel {
    static tableName = "widget165";
    static fields: Record<string, FieldDefinition> = {
      id:       { type: "integer", primaryKey: true, autoIncrement: true },
      label:    { type: "string", default: "from-orm" }, // non-null ORM default
      quantity: { type: "integer" },
      note:     { type: "string" },
    };
  }
  const w = new Widget165Defaulted(); // label unset by caller, ORM default non-null
  const saved = await w.save();
  assert("non-null ORM default: save() succeeds", saved !== false, `err=${w.getError()}`);
  const row = await rowById((w as any).id);
  assert("non-null ORM default written (not omitted)", row?.label === "from-orm", `got ${JSON.stringify(row)}`);
}

await closeDatabase();

console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
