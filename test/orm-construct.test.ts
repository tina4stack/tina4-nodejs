/**
 * ORM constructor accepts an object or a JSON object string (one record),
 * and rejects an array with a clear TypeError (was previously a silent empty
 * model). Run with: npx tsx test/orm-construct.test.ts
 */
import { BaseModel } from "../packages/orm/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

class CtorWidget extends BaseModel {
  static tableName = "ctor_widget";
  static fields = {
    id: { type: "integer" as const, primaryKey: true },
    name: { type: "string" as const },
    active: { type: "boolean" as const },
  };
}

{
  const w = new CtorWidget({ id: 1, name: "alpha", active: true }) as any;
  assert("from object", w.id === 1 && w.name === "alpha" && w.active === true);
}
{
  const w = new CtorWidget('{"id":3,"name":"gamma"}' as unknown as Record<string, unknown>) as any;
  assert("from JSON object string", w.id === 3 && w.name === "gamma");
}
{
  let threw = false;
  try { new CtorWidget(["a", "b"] as unknown as Record<string, unknown>); } catch { threw = true; }
  assert("array rejected (was silent empty)", threw);
}
{
  let threw = false;
  try { new CtorWidget('[{"id":4}]' as unknown as Record<string, unknown>); } catch { threw = true; }
  assert("JSON array string rejected", threw);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);
