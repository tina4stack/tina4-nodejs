/**
 * JSONField parity tests — a "json" field maps an object/array to a JSON column
 * (JSON-encoded on write, JSON-decoded on read). Parity with the Python master.
 *
 * NO MOCKS: every test runs against a REAL SQLite database on disk, exercising
 * the full path createTable -> save (serialize) -> fetch -> hydrate (parse).
 * The engine-aware DDL type and native-JSON read normalisation (PostgreSQL
 * JSONB / MySQL JSON) are covered by the gated cross-engine suites in CI; the
 * string-backed path is fully exercised here.
 *
 * Run with: npx tsx test/ormJsonField.test.ts
 */
import { rmSync, mkdirSync } from "node:fs";
import {
  initDatabase,
  closeDatabase,
  getAdapter,
  BaseModel,
} from "../packages/orm/src/index.ts";
import type { FieldDefinition } from "../packages/orm/src/index.ts";

const TEST_DB = "/tmp/tina4-json-test/test.db";
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

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

try { rmSync("/tmp/tina4-json-test", { recursive: true }); } catch {}
mkdirSync("/tmp/tina4-json-test", { recursive: true });

console.log("=== ORM JSONField Tests ===\n");

await initDatabase({ type: "sqlite", path: TEST_DB });

class JsonDoc extends BaseModel {
  static tableName = "jsondoc";
  static fields: Record<string, FieldDefinition> = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
    payload: { type: "json" },
    tags: { type: "json" },
  };
}

class JsonDefaultDoc extends BaseModel {
  static tableName = "jsondefaultdoc";
  static fields: Record<string, FieldDefinition> = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    meta: { type: "json", default: {} },
  };
}

await JsonDoc.createTable();
await JsonDefaultDoc.createTable();
const adapter = getAdapter();

// --- Round trip ---
{
  const doc = new JsonDoc({ name: "click", payload: { x: 1, nested: { a: [1, 2, 3] } } });
  await doc.save();
  const got = await JsonDoc.selectOne("SELECT * FROM jsondoc WHERE id = ?", [doc.id]);
  assert("dict round-trips as an object", got !== null && typeof got.payload === "object" && !Array.isArray(got.payload), `got: ${typeof got?.payload}`);
  assert("dict value preserved", got !== null && eq(got.payload, { x: 1, nested: { a: [1, 2, 3] } }), JSON.stringify(got?.payload));
}
{
  const doc = new JsonDoc({ name: "tagged", tags: ["a", "b", "c"] });
  await doc.save();
  const got = await JsonDoc.selectOne("SELECT * FROM jsondoc WHERE id = ?", [doc.id]);
  assert("list round-trips as an array", got !== null && eq(got.tags, ["a", "b", "c"]), JSON.stringify(got?.tags));
}
{
  const doc = new JsonDoc({ name: "empty" });
  await doc.save();
  const got = await JsonDoc.selectOne("SELECT * FROM jsondoc WHERE id = ?", [doc.id]);
  assert("null payload round-trips as null", got !== null && got.payload === null, JSON.stringify(got?.payload));
  assert("null tags round-trips as null", got !== null && got.tags === null, JSON.stringify(got?.tags));
}
{
  const doc = new JsonDoc({ name: "v", payload: { v: 1 } });
  await doc.save();
  doc.payload = { v: 2, changed: true };
  await doc.save();
  const got = await JsonDoc.selectOne("SELECT * FROM jsondoc WHERE id = ?", [doc.id]);
  assert("update replaces the JSON", got !== null && eq(got.payload, { v: 2, changed: true }), JSON.stringify(got?.payload));
}
{
  const body = { emoji: "cafe ☕", quote: 'he said "hi"', slash: "a/b\\c" };
  const doc = new JsonDoc({ name: "u", payload: body });
  await doc.save();
  const got = await JsonDoc.selectOne("SELECT * FROM jsondoc WHERE id = ?", [doc.id]);
  assert("unicode + special chars survive", got !== null && eq(got.payload, body), JSON.stringify(got?.payload));
}

// --- Engine-aware DDL ---
{
  const cols = (adapter as any).getTableColumns("jsondoc") as Array<{ name: string; type: string }>;
  const payloadCol = cols.find((c) => c.name === "payload");
  const tagsCol = cols.find((c) => c.name === "tags");
  assert("payload column maps to TEXT on SQLite", !!payloadCol && /TEXT/i.test(payloadCol.type), payloadCol?.type);
  assert("tags column maps to TEXT on SQLite", !!tagsCol && /TEXT/i.test(tagsCol.type), tagsCol?.type);
}

// --- Parse on read ---
{
  // A raw JSON string in the column (as a text-backed engine returns) is
  // decoded to an object on hydration.
  adapter.execute("INSERT INTO jsondoc (name, payload) VALUES (?, ?)", ["raw", '{"from": "string"}']);
  const got = await JsonDoc.selectOne("SELECT * FROM jsondoc WHERE name = ?", ["raw"]);
  assert("raw JSON string is parsed on read", got !== null && eq(got.payload, { from: "string" }), JSON.stringify(got?.payload));
}

// --- Fail loud on a non-serialisable value ---
{
  const circular: Record<string, unknown> = {};
  circular.self = circular; // JSON.stringify throws on a circular reference
  const doc = new JsonDoc({ name: "bad" });
  doc.payload = circular;
  const result = await doc.save();
  assert("non-serialisable save() returns false", result === false, String(result));
  assert("non-serialisable save() records the cause", doc.getError() !== null);
  const got = await JsonDoc.selectOne("SELECT * FROM jsondoc WHERE name = ?", ["bad"]);
  assert("nothing persisted for the failed save", got === null, JSON.stringify(got));
}

// --- Mutable default isolation ---
{
  const a = new JsonDefaultDoc();
  const b = new JsonDefaultDoc();
  (a.meta as Record<string, unknown>).only_a = true;
  assert("mutable default is not shared between instances", eq(b.meta, {}), JSON.stringify(b.meta));
}

closeDatabase();
try { rmSync("/tmp/tina4-json-test", { recursive: true }); } catch {}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
