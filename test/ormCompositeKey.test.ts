/**
 * The ORM layer must honour a COMPOSITE primary key (feature 4, open item).
 *
 * Feature 4 fixed the raw write path: update()/delete() put EVERY primary-key
 * column in the WHERE, because keying on one column of a composite key matches
 * every row sharing that value. The ORM layer ABOVE it was never fixed, so the
 * data-loss shape lived on one level up. Three defects came out of
 * `getPkField()` returning a single column:
 *
 *   1. SAVING A NEW ROW OVERWROTE AN EXISTING ONE. The INSERT-vs-UPDATE
 *      decision asked exists(pkValue) with only the FIRST key column, which is
 *      true for ANY row sharing it, so a genuinely new row was decided to be an
 *      UPDATE. Saving (acme, a2) rewrote (acme, a1). The worst of the three: it
 *      destroys data on an ordinary insert, with no error.
 *   2. UPDATE and DELETE keyed on one column, hitting every row sharing it.
 *   3. createTable() emitted an inline PRIMARY KEY on EACH key column, which is
 *      invalid DDL - SQLite, PostgreSQL and MySQL all reject two of them.
 *
 * Real SQLite, no mocks: the DDL defect only shows against an engine that
 * actually parses the statement.
 *
 * Run with: npx tsx test/ormCompositeKey.test.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, bindDatabase, getAdapter } from "../packages/orm/src/database.js";
import { BaseModel } from "../packages/orm/src/baseModel.js";

let pass = 0;
let fail = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m-\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const dbPath = join(mkdtempSync(join(tmpdir(), "tina4-ck-")), "composite.db");
const db = await initDatabase({ url: `sqlite://${dbPath}` });
bindDatabase(getAdapter() as never);

class Membership extends BaseModel {
  static tableName = "membership";
  static fields = {
    tenant: { type: "string" as const, primaryKey: true },
    code: { type: "string" as const, primaryKey: true },
    label: { type: "string" as const },
    seats: { type: "integer" as const },
  };
  declare tenant: string;
  declare code: string;
  declare label: string;
  declare seats: number;
}

class Widget extends BaseModel {
  static tableName = "widget";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const },
  };
  declare id: number;
  declare name: string;
}

console.log("=== ORM composite primary key (live SQLite) ===\n");

// The resolver must report BOTH columns.
assert(
  "the model reports every primary-key column",
  JSON.stringify((Membership as never as { getPkFields(): string[] }).getPkFields()) ===
    JSON.stringify(["tenant", "code"]),
);

// DDL: ONE table-level clause, naming both columns. Two inline PRIMARY KEYs is
// invalid SQL and the CREATE would be rejected outright.
await Membership.createTable();
const ddlRow = await db.fetchOne<{ sql: string }>(
  "SELECT sql FROM sqlite_master WHERE type='table' AND name='membership'",
);
const ddl = (ddlRow?.sql ?? "").toUpperCase();
assert("createTable emits ONE primary-key clause", (ddl.match(/PRIMARY KEY/g) ?? []).length === 1, ddl);
assert(
  "...and names both key columns in it",
  ddl.split("PRIMARY KEY")[1]?.includes("TENANT") && ddl.split("PRIMARY KEY")[1]?.includes("CODE"),
  ddl,
);

// The data-loss case: two rows sharing `tenant`.
await new Membership({ tenant: "acme", code: "a1", label: "first", seats: 1 }).save();
await new Membership({ tenant: "acme", code: "a2", label: "second", seats: 2 }).save();

const afterInserts = await db.fetch("SELECT * FROM membership ORDER BY code", [], 100);
assert(
  "saving a second row with the same first key column INSERTS it",
  afterInserts.records.length === 2,
  `got ${afterInserts.records.length} row(s) - a new row overwrote an existing one`,
);

await new Membership({ tenant: "acme", code: "a1", label: "CHANGED", seats: 99 }).save();
const afterUpdate = await db.fetch("SELECT * FROM membership ORDER BY code", [], 100);
const byCode = Object.fromEntries(
  afterUpdate.records.map((r) => [(r as Record<string, unknown>).code, r as Record<string, unknown>]),
);
assert("save updates the addressed row", byCode.a1?.label === "CHANGED");
assert(
  "...and leaves the row sharing its first key column alone",
  byCode.a2?.label === "second" && Number(byCode.a2?.seats) === 2,
  "saving a1 rewrote a2 - the key is being truncated",
);

// Same hazard on delete.
await new Membership({ tenant: "acme", code: "a1" }).delete();
const afterDelete = await db.fetch("SELECT code FROM membership", [], 100);
assert(
  "delete removes only the addressed row",
  afterDelete.records.length === 1 &&
    (afterDelete.records[0] as Record<string, unknown>).code === "a2",
  `${afterDelete.records.length} row(s) left - delete truncated the key`,
);

// The common case must not regress.
assert(
  "negative: a single-key model still reports one key",
  JSON.stringify((Widget as never as { getPkFields(): string[] }).getPkFields()) ===
    JSON.stringify(["id"]),
);
await Widget.createTable();
const wDdl = (
  await db.fetchOne<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='widget'",
  )
)?.sql?.toUpperCase() ?? "";
assert(
  "negative: a single-key model keeps the INLINE primary key",
  (wDdl.match(/PRIMARY KEY/g) ?? []).length === 1 && !wDdl.includes("PRIMARY KEY ("),
  wDdl,
);
const w = new Widget({ name: "one" });
await w.save();
assert("negative: a single-key model still saves and finds", (await Widget.find(w.id)) !== null);

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

db.close();
process.exit(fail > 0 ? 1 : 0);
