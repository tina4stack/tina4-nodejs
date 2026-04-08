import { BaseModel } from "../packages/orm/src/baseModel.js";

const results: string[] = [];
let passed = 0;
let failed = 0;

// Test 1: autoCrud defaults to false
{
  class Widget extends BaseModel {
    static tableName = "widgets";
    static fields = { id: { type: "integer" as const, primaryKey: true } };
  }
  if (Widget.autoCrud === false) {
    passed++;
    results.push("  PASS  autoCrud defaults to false");
  } else {
    failed++;
    results.push("  FAIL  autoCrud should default to false");
  }
}

// Test 2: autoCrud can be set to true
{
  class Gadget extends BaseModel {
    static tableName = "gadgets";
    static fields = { id: { type: "integer" as const, primaryKey: true } };
    static autoCrud = true;
  }
  if (Gadget.autoCrud === true) {
    passed++;
    results.push("  PASS  autoCrud can be set to true");
  } else {
    failed++;
    results.push("  FAIL  autoCrud should be settable to true");
  }
}

console.log(`  PASS  autoCrudFlag.test (${passed} passed)`);
if (failed > 0) {
  results.forEach(r => console.log(r));
  process.exit(1);
}
