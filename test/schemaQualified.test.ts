/**
 * Tina4 Node.js — v3.13.14 (#48) schema-qualified table introspection.
 *
 * A model whose table name is schema/catalog-qualified was invisible to
 * tableExists()/getColumns()/getTables() — they hardcoded the default
 * namespace and matched the dotted string as one flat name. SQLite's
 * "schema" is an ATTACH alias, which needs no external server, so it gives
 * the schema-qualified path real coverage here. PostgreSQL/MySQL/MSSQL use
 * the same SQLTranslator.splitSchema() helper (unit-tested below); their live
 * behaviour is covered when a container is present.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, closeDatabase, SQLTranslator } from "../packages/orm/src/index.ts";

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

function eqArr(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

console.log("=== Schema-qualified introspection (#48) ===\n");

// ── Unit: SQLTranslator.splitSchema (the shared helper) ────────────
console.log("--- SQLTranslator.splitSchema (unit) ---");
assert("bare name → [null, name]", eqArr(SQLTranslator.splitSchema("users"), [null, "users"]));
assert(
  "qualified name splits on first dot",
  eqArr(SQLTranslator.splitSchema("gift_cards.gift_card"), ["gift_cards", "gift_card"]),
);
assert("splits on FIRST dot only", eqArr(SQLTranslator.splitSchema("a.b.c"), ["a", "b.c"]));

// ── Integration: SQLite attached-database (no server needed) ───────
console.log("\n--- SQLite attached-database introspection ---");
const tmp = mkdtempSync(join(tmpdir(), "tina4-schema-qualified-"));
const mainPath = join(tmp, "main.db");
const attPath = join(tmp, "extra.db");

try {
  const db = await initDatabase({ url: `sqlite:///${mainPath}` });
  await db.execute(`ATTACH DATABASE '${attPath}' AS extra`);
  await db.execute("CREATE TABLE extra.widget (id INTEGER PRIMARY KEY, name TEXT, is_deleted INTEGER DEFAULT 0)");
  await db.execute("CREATE TABLE local_only (id INTEGER PRIMARY KEY)");

  assert("tableExists finds attached-schema table", (await db.tableExists("extra.widget")) === true);
  assert("tableExists false for absent attached table", (await db.tableExists("extra.nope")) === false);
  assert("tableExists still finds bare main-schema table", (await db.tableExists("local_only")) === true);

  const cols = await db.getColumns("extra.widget");
  const names = cols.map((c) => c.name);
  assert("getColumns reads attached-schema columns", eqArr(names, ["id", "name", "is_deleted"]), `(got ${names.join(",")})`);
  const idCol = cols.find((c) => c.name === "id");
  assert("getColumns marks primary key", idCol?.primaryKey === true);
} finally {
  try { await closeDatabase(); } catch {}
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
