/**
 * Lock-in contract: EVERY ORM read path that takes a `limit` caps at 100 by default.
 *
 * Pagination is a default principle in Tina4: an un-paginated read of a table
 * that grew to a million rows is a memory and latency incident waiting for
 * production. Before this contract the family disagreed with ITSELF about the
 * number - Python and PHP capped all/find at 100 but select/where/withTrashed/
 * cached/scope at 20, Ruby's all/select/where passed `limit: nil` (which made
 * fetch skip its LIMIT entirely, so they returned EVERY row), and NODE's
 * all/select had no limit parameter at all. Four frameworks, four answers, same
 * method names.
 *
 * One number, everywhere: 100.
 *
 * These tests are deliberately BEHAVIOURAL, never source-reading. They insert
 * 150 rows and count what comes back, so the contract cannot be satisfied by a
 * signature that says 100 while the body ignores it, and cannot rot into a grep
 * of the default value.
 *
 * Two paths are EXCLUDED from the cap, on purpose, each with its own test below
 * so the exclusion is a decision on the record rather than an oversight:
 *
 *   - QueryBuilder.get() - uncapped since v3.13.39. A silent default LIMIT 100
 *     there was a data-loss-on-read footgun: .where(...).get() dropped the 101st
 *     row with no signal, because get() has no `limit` parameter to make the cap
 *     visible. Re-adding it would re-introduce that exact bug.
 *   - fetchAll() - its name IS the request for every row.
 *
 * The distinction that reconciles the two groups: a path whose signature
 * ADVERTISES `limit` caps at 100 (visible, documented, overridable in the call);
 * a path with NO limit parameter must never cap, because there the cap can only
 * ever be silent.
 *
 * KNOWN SIGNATURE DIVERGENCE, recorded not fixed here: Node's `all()` takes
 * (where, params, include, orderBy) while the Python master's takes
 * (limit, offset, include, order_by). The limit/offset pair is therefore
 * APPENDED on Node, so `Model.all(10)` means a WHERE clause here and a limit
 * there. Re-ordering the parameters is a separate breaking change and is not in
 * scope for the row cap.
 *
 * Mirrors tests/test_orm_row_cap.py (the Python master).
 * Run with: npx tsx test/ormRowCap.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseModel, QueryBuilder, initDatabase, closeDatabase,
} from "../packages/orm/src/index.ts";

const ROWS = 150;
const CAP = 100;

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

class CapWidget extends BaseModel {
  static tableName = "cap_widgets";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    label: { type: "string" as const },
    is_deleted: { type: "integer" as const },
  };
}

class CapWidgetSoft extends BaseModel {
  static tableName = "cap_widgets";
  static softDelete = true;
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    label: { type: "string" as const },
    is_deleted: { type: "integer" as const },
  };
}

console.log("=== ORM default row cap is 100 ===\n");

const tmp = mkdtempSync(join(tmpdir(), "tina4-row-cap-"));

async function run() {
  const db = await initDatabase({ url: `sqlite:///${join(tmp, "row_cap.db")}` });
  await db.execute(
    'CREATE TABLE cap_widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, is_deleted INTEGER DEFAULT 0)',
  );
  for (let i = 0; i < ROWS; i++) {
    await db.execute("INSERT INTO cap_widgets (label, is_deleted) VALUES (?, 0)", [`w${i}`]);
  }

  // Sanity: the fixture really does exceed the cap, else every assertion below
  // would pass for the wrong reason.
  const seed = await db.fetchOne("SELECT COUNT(*) AS c FROM cap_widgets");
  assert(`fixture holds ${ROWS} rows (more than the cap)`, Number((seed as any)?.c) === ROWS,
    `got ${JSON.stringify(seed)}`);

  console.log("\n--- the default cap on every path that advertises limit ---");
  {
    // `all` had NO limit parameter at all before this change.
    assert("all() returns 100", (await CapWidget.all()).length === CAP,
      `got ${(await CapWidget.all()).length}`);

    assert("find({}) returns 100", (await CapWidget.find({})).length === CAP,
      `got ${(await CapWidget.find({})).length}`);

    // `select` also had NO limit parameter.
    const sel = await CapWidget.select("SELECT * FROM cap_widgets");
    assert("select() returns 100", sel.length === CAP, `got ${sel.length}`);

    // Was 20: a caller asking for a page got a fifth of one.
    const wh = await CapWidget.where("1=1");
    assert("where() returns 100", wh.length === CAP, `got ${wh.length}`);

    const wt = await CapWidgetSoft.withTrashed();
    assert("withTrashed() returns 100", wt.length === CAP, `got ${wt.length}`);

    const cch = await CapWidget.cached("SELECT * FROM cap_widgets");
    assert("cached() returns 100", cch.length === CAP, `got ${cch.length}`);

    CapWidget.scope("every", "1=1");
    const sc = await (CapWidget as any).every();
    assert("a scope-generated method returns 100", sc.length === CAP, `got ${sc.length}`);

    const f = await db.fetch("SELECT * FROM cap_widgets");
    // records, NOT count - `count` is the TOTAL matching rows (what pagination
    // needs) and stays 150 regardless of truncation.
    assert("db.fetch() returns 100 records", (f as any).records.length === CAP,
      `got ${(f as any).records.length}`);
  }

  console.log("\n--- the negative half: the cap is a DEFAULT, not a ceiling ---");
  // Without these, a hardcoded LIMIT 100 would satisfy every test above.
  {
    assert("where() honours a smaller limit", (await CapWidget.where("1=1", [], 7)).length === 7);
    assert("select() honours a smaller limit",
      (await CapWidget.select("SELECT * FROM cap_widgets", [], 7)).length === 7);
    assert("withTrashed() honours a smaller limit",
      (await CapWidgetSoft.withTrashed("1=1", [], 7)).length === 7);
    assert("cached() honours a smaller limit",
      (await CapWidget.cached("SELECT * FROM cap_widgets", [], 60, 7)).length === 7);
    assert("a scope method honours a smaller limit",
      (await (CapWidget as any).every(5)).length === 5);

    assert("where() reaches past the cap", (await CapWidget.where("1=1", [], ROWS)).length === ROWS);
    assert("select() reaches past the cap",
      (await CapWidget.select("SELECT * FROM cap_widgets", [], ROWS)).length === ROWS);
    const big = await db.fetch("SELECT * FROM cap_widgets", [], ROWS);
    assert("db.fetch() reaches past the cap", (big as any).records.length === ROWS,
      `got ${(big as any).records.length}`);
  }

  console.log("\n--- the deliberate exclusions ---");
  // A path with NO limit parameter must stay UNCAPPED: a cap the signature
  // cannot express is a silent cap, which is the footgun.
  {
    // SHAPE DIVERGENCE, recorded not fixed: Node's QueryBuilder.get() returns a
    // plain array, while Python/PHP/Ruby return a DatabaseResult (.records).
    // Out of scope for the row cap; noted so the next reader is not surprised.
    const all = await QueryBuilder.fromTable("cap_widgets").get();
    assert("QueryBuilder.get() returns every row", all.length === ROWS, `got ${all.length}`);

    const nine = await QueryBuilder.fromTable("cap_widgets").limit(9).get();
    assert("QueryBuilder.get() honours an explicit limit", nine.length === 9, `got ${nine.length}`);
  }

  await closeDatabase();
}

run()
  .catch((e) => {
    console.error("UNEXPECTED ERROR:", e);
    fail++;
  })
  .finally(() => {
    rmSync(tmp, { recursive: true, force: true });
    console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
    process.exit(fail > 0 ? 1 : 0);
  });
