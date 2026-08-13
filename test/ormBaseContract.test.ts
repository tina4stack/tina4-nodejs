/**
 * ORM base class contract -- feature 17 (ORM17-DEC-01).
 * Run with: npx tsx test/ormBaseContract.test.ts
 *
 * Shared conformance fixture:
 *   tina4-documentation/plan/v3/fixtures/ormbase_contract.json
 *
 * The SAFETY NET for the ORM17-DEC-01 vestigial-state cleanup. In Node the
 * removals are: BaseModel `_exists` (written on find/load/save via
 * `(x as any)._exists = true` but NEVER read -- grep-confirmed) and the dead
 * local `pkCol` in delete/forceDelete/restore (computed and never read; the
 * write path addresses the row via pkWhere()). Node's `tableFilter` is NOT
 * vestigial (declared static, read in findById/all/where/count/withTrashed, used
 * by AutoCrud) and STAYS.
 *
 * The removal is BEHAVIOUR-PRESERVING, so this real round-trip (save -> load ->
 * query -> re-save/update -> count -> delete) passes IDENTICALLY before AND after
 * it. NO mocks: a REAL SQLite database, real rows, real ORM writes. Positive: a
 * save loads back with identical values, count() is the live total, where()
 * finds by a non-key column, a re-save UPDATEs in place. Negative: the re-save
 * does not insert a duplicate (guards the _exists removal -- the insert-vs-update
 * decision never consulted it), and a deleted model is ABSENT from findById() and
 * count() (guards the dead-local removal in delete()).
 */
import { rmSync, mkdirSync } from "node:fs";
import { initDatabase, closeDatabase, getAdapter, BaseModel } from "../packages/orm/src/index.ts";
import type { FieldDefinition } from "../packages/orm/src/index.ts";

const TEST_DIR = "/tmp/tina4-ormbase-test";
const TEST_DB = `${TEST_DIR}/ormbase.db`;

let pass = 0;
let fail = 0;
function assertEqual(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} -- expected ${e}, got ${a}`);
    fail++;
  }
}

class BaseWidget extends BaseModel {
  static tableName = "basewidget";
  static fields: Record<string, FieldDefinition> = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
    qty: { type: "integer" },
  };
}

try { rmSync(TEST_DIR, { recursive: true }); } catch { /* fresh slate */ }
mkdirSync(TEST_DIR, { recursive: true });

await initDatabase({ type: "sqlite", path: TEST_DB });
const adapter = getAdapter()!;

/**
 * Fresh table before each case (single-process script). `name` is UNIQUE so
 * the constraint-violation case below has a real driver error to trigger --
 * none of the other cases in this file ever insert a duplicate name within
 * one reset() window, so the extra constraint is inert for them.
 */
function reset(): void {
  adapter.execute("DROP TABLE IF EXISTS basewidget");
  adapter.execute(
    "CREATE TABLE basewidget (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, qty INTEGER)",
  );
}

async function newWidget(name: string, qty: number): Promise<void> {
  await new BaseWidget({ name, qty }).save();
}

// ── Invariant: write/read round-trip; no duplicate on re-save ──────────────

{
  reset();
  const widget = new BaseWidget({ name: "alpha", qty: 7 });
  const saved = await widget.save();
  const loaded = await BaseWidget.findById((widget as Record<string, unknown>).id);
  assertEqual(
    "a saved model loads back with identical values",
    [saved !== false, loaded !== null, loaded?.name, loaded?.qty],
    [true, true, "alpha", 7],
  );
}

{
  reset();
  await newWidget("w0", 0);
  await newWidget("w1", 1);
  await newWidget("w2", 2);
  // Guards Node's removed... no -- guards PHP's removed tableFilter; count() is
  // exactly the live row total in every framework.
  assertEqual("count returns the live row total", await BaseWidget.count(), 3);
}

{
  reset();
  await newWidget("alpha", 1);
  await newWidget("beta", 2);
  const rows = await BaseWidget.where("name = ?", ["beta"]);
  assertEqual(
    "where returns a row matched by a non key column",
    [rows.length, rows[0]?.name, rows[0]?.qty],
    [1, "beta", 2],
  );
}

{
  reset();
  await newWidget("alpha", 1);
  const before = await BaseWidget.count();
  const loaded = await BaseWidget.findById(1);
  (loaded as Record<string, unknown>).qty = 99;
  await loaded!.save();
  const after = await BaseWidget.count();
  const reloaded = await BaseWidget.findById(1);
  // Guards Node's removed _exists: the insert-vs-update decision never used it,
  // so a re-saved found instance UPDATEs in place -- the row total stays 1.
  assertEqual(
    "a re-saved model updates in place not a duplicate",
    [before, after, reloaded?.qty],
    [1, 1, 99],
  );
}

// ── Invariant: delete removes the row (negative absence) ───────────────────

{
  reset();
  await newWidget("alpha", 1);
  const loaded = await BaseWidget.findById(1);
  await loaded!.delete();
  const gone = await BaseWidget.findById(1);
  const cnt = await BaseWidget.count();
  // Guards the dead-local (pkCol) removal in delete().
  assertEqual("a deleted model is absent from find and count", [gone, cnt], [null, 0]);
}

// ── Invariant: save() returns false, never raises, on a real constraint
// violation -- the write-path fail-loud fix (Database.insert() now throws on
// SQLite) must not ripple into BaseModel.save() raising too. save()'s insert
// path never calls Database.insert() -- it builds its own INSERT and runs it
// through adapterExecute(), which already fails loud, and save()'s own
// try/catch already converts that throw into `false` (unaffected by the
// Database.insert() fix; characterised here so the contract stays pinned). ──

{
  reset();
  await newWidget("alpha", 1);
  const before = await BaseWidget.count();
  const duplicate = new BaseWidget({ name: "alpha", qty: 2 }); // UNIQUE(name) collides
  let threw = false;
  let result: unknown = "unset";
  try {
    result = await duplicate.save();
  } catch {
    threw = true;
  }
  const after = await BaseWidget.count();
  assertEqual(
    "save_on_constraint_violation_returns_false",
    [threw, result, before, after, duplicate.getError() !== null],
    [false, false, 1, 1, true],
  );
}

closeDatabase();
try { rmSync(TEST_DIR, { recursive: true }); } catch { /* best effort */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
