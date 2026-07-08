/**
 * Regression for #61: createTable() must OMIT callable field defaults from the DDL.
 *
 * A callable default (e.g. `created_at: { type: "datetime", default: () => new Date() }`)
 * was stringified into CREATE TABLE as `DEFAULT () => ...` via String(fn) — invalid SQL
 * that silently failed table creation, so a later save()/all() hit "no such table".
 * Callable defaults are resolved per-row in the constructor; they must not reach the DDL.
 *
 * NOT a mock: real node:sqlite database, real createTable DDL, real save/all round-trip.
 * Run with: npx tsx test/createTableCallableDefault.test.ts
 */
import { rmSync, mkdirSync } from "node:fs";
import { initDatabase, closeDatabase, BaseModel } from "../packages/orm/src/index.ts";
import type { FieldDefinition } from "../packages/orm/src/index.ts";

const DIR = "/tmp/tina4-cd61-test";
let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail = ""): void {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

try { rmSync(DIR, { recursive: true }); } catch { /* first run */ }
mkdirSync(DIR, { recursive: true });

console.log("=== createTable callable-default DDL (#61) ===\n");

await initDatabase({ type: "sqlite", path: `${DIR}/test.db` });

class NoteCd61 extends BaseModel {
  static tableName = "note_cd61";
  static fields: Record<string, FieldDefinition> = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "string", default: "untitled" },              // static -> stays in DDL
    created_at: { type: "datetime", default: () => new Date() },  // callable -> omitted
  };
}
BaseModel.registerModel("NoteCd61", NoteCd61);

// Before #61 this returned false (DDL had `DEFAULT () => ...`, sqlite syntax error).
const created = await NoteCd61.createTable();
assert("createTable() succeeds with a callable default (omitted from DDL)", created === true, `got ${created}`);

// The table really exists and a row round-trips; the callable resolves per-row.
const note = new NoteCd61({ title: "hello" });
const saved = await note.save();
assert("save() succeeds against the created table", saved !== false);

const rows = await NoteCd61.all();
assert("all() returns the one saved row", Array.isArray(rows) && rows.length === 1, `got ${JSON.stringify(rows)}`);
assert("static default persisted", rows.length === 1 && (rows[0] as any).title === "hello");
assert("callable default resolved at insert (not null)", rows.length === 1 && (rows[0] as any).created_at != null);

await closeDatabase();

console.log(`\ncreateTable callable-default tests: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
