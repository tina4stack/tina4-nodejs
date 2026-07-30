/**
 * Parity sweep: confirm Python-style static class helpers are available
 * on BaseModel — findOrFail, count, withTrashed, scope — and that seedOrm
 * works on a real ORM model, not just plain objects.
 *
 * Mirrors tina4-python's `MyModel.find_or_fail(pk)`, `MyModel.count(...)`,
 * `MyModel.with_trashed(...)`, `MyModel.scope(name, sql, params)` and
 * `seed_orm(ModelClass, count, overrides, seed)`.
 *
 * Run with: npx tsx test/parityStaticOrm.test.ts
 */
import { rmSync, mkdirSync } from "node:fs";
import {
  initDatabase,
  closeDatabase,
  getAdapter,
  BaseModel,
  syncModels,
  seedOrm,
} from "../packages/orm/src/index.ts";
import type { FieldDefinition, DiscoveredModel } from "../packages/orm/src/index.ts";

const TEST_DB = "/tmp/tina4-parity-static-orm/test.db";
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

// Clean slate
try { rmSync("/tmp/tina4-parity-static-orm", { recursive: true }); } catch {}
mkdirSync("/tmp/tina4-parity-static-orm", { recursive: true });

console.log("=== Parity: Static ORM Helpers + seedOrm ===\n");

await initDatabase({ type: "sqlite", path: TEST_DB });

class User extends BaseModel {
  static tableName = "users";
  static fields: Record<string, FieldDefinition> = {
    id:    { type: "integer", primaryKey: true, autoIncrement: true },
    name:  { type: "string", required: true, maxLength: 50 },
    email: { type: "string", required: true, maxLength: 100 },
    age:   { type: "integer", min: 0, max: 150 },
  };
}

class Article extends BaseModel {
  static tableName = "articles";
  static softDelete = true;
  static fields: Record<string, FieldDefinition> = {
    id:        { type: "integer", primaryKey: true, autoIncrement: true },
    title:     { type: "string", required: true, maxLength: 200 },
    author_id: { type: "integer" },
  };
}

const userModel: DiscoveredModel = {
  definition: { tableName: "users", fields: User.fields },
  filePath: "test",
  modelClass: User,
};
const articleModel: DiscoveredModel = {
  definition: { tableName: "articles", fields: Article.fields, softDelete: true },
  filePath: "test",
  modelClass: Article,
};

await syncModels([userModel, articleModel]);

// --- Static helpers: each exercised against a throwaway Probe model so the
// behaviour is proven here without polluting the users/articles row counts the
// blocks below depend on. (Formerly bare `typeof === "function"` existence
// checks — now real behavioural assertions against the live SQLite DB.) ---
console.log("--- Static Helpers (behavioural smoke) ---");

class Probe extends BaseModel {
  static tableName = "probes";
  static softDelete = true;
  static fields: Record<string, FieldDefinition> = {
    id:   { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string", required: true, maxLength: 50 },
    rank: { type: "integer", min: 0, max: 100 },
  };
}
const probeModel: DiscoveredModel = {
  definition: { tableName: "probes", fields: Probe.fields, softDelete: true },
  filePath: "test",
  modelClass: Probe,
};
await syncModels([probeModel]);

// seedOrm: prove it actually inserts rows into the real table (not just that it
// is exported). Seed 4 probes (rank pinned low so they never collide with the
// scope assertion below) and confirm they landed.
const probeSeed = await seedOrm(Probe as any, 4, { rank: 0 }, 7);
assert(
  "seedOrm inserts real rows (returns count + rows land)",
  probeSeed.seeded === 4 && (await Probe.count()) === 4,
);

// Give two rows known ranks so the scope/count assertions are deterministic.
const p1 = new Probe({ name: "Pinned", rank: 90 });
await p1.save();
const p2 = new Probe({ name: "Lowly", rank: 5 });
await p2.save();
const pinnedId = (p1 as any).id;

// findOrFail: returns the exact row for a known id (not just that it exists).
const pinned = await Probe.findOrFail(pinnedId);
assert("findOrFail returns the row for a known id", (pinned as any).name === "Pinned");

// count: returns the true total — 4 seeded + 2 explicit = 6 live rows.
assert("count() returns the real total row count", (await Probe.count()) === 6);

// scope: registers a callable that runs the real WHERE and filters rows.
Probe.scope("highRank", "rank >= ?", [50]);
const highRank = await (Probe as any).highRank();
assert(
  "scope() runs the registered query and filters rows",
  Array.isArray(highRank) && highRank.length === 1 && (highRank[0] as any).name === "Pinned",
);

// withTrashed: soft-delete one row, then prove withTrashed sees it while the
// default all() (and count()) excludes it.
await p2.delete(); // soft delete "Lowly"
const probeLive = await Probe.all();
const probeAll = await Probe.withTrashed();
assert(
  "withTrashed() includes a soft-deleted row that all() excludes",
  probeAll.length === probeLive.length + 1,
);

// Drop the probe table so it cannot interfere with the focused blocks below.
getAdapter().execute(`DROP TABLE IF EXISTS "probes"`);

// --- findOrFail ---
console.log("\n--- findOrFail ---");
const alice = new User({ name: "Alice", email: "alice@test.com", age: 30 });
await alice.save();
const bob = new User({ name: "Bob", email: "bob@test.com", age: 25 });
await bob.save();

const aliceId = (alice as any).id;
const found = await User.findOrFail(aliceId);
assert("findOrFail returns the row", (found as any).name === "Alice");

let threw = false;
let errMsg = "";
try {
  await User.findOrFail(999_999);
} catch (e) {
  threw = true;
  errMsg = (e as Error).message;
}
assert("findOrFail throws on missing", threw);
assert("findOrFail error mentions table", errMsg.includes("users"));
assert("findOrFail error mentions id", errMsg.includes("999999") || errMsg.includes("999,999"));

// --- count ---
console.log("\n--- count ---");
const charlie = new User({ name: "Charlie", email: "charlie@test.com", age: 40 });
await charlie.save();
assert("count() returns total rows", (await User.count()) === 3);
assert("count(conditions, params) filters", (await User.count("age > ?", [27])) === 2);
assert("count() with no matches returns 0", (await User.count("age > ?", [1000])) === 0);

// --- withTrashed (soft delete) ---
console.log("\n--- withTrashed ---");
const a1 = new Article({ title: "Live", author_id: aliceId });
await a1.save();
const a2 = new Article({ title: "Dead", author_id: aliceId });
await a2.save();
await a2.delete(); // soft delete

const liveOnly = await Article.all();
assert("Article.all() excludes soft-deleted", liveOnly.length === 1);

const includingTrashed = await Article.withTrashed();
assert("withTrashed() includes soft-deleted rows", includingTrashed.length === 2);

const trashedFiltered = await Article.withTrashed("title = ?", ["Dead"]);
assert(
  "withTrashed(conditions) filters and includes soft-deleted",
  trashedFiltered.length === 1 && (trashedFiltered[0] as any).title === "Dead",
);

// withTrashed should also respect count() semantics on count() — count itself
// excludes soft-deleted (matches Python). withTrashed gives a way to bypass.
assert("count still excludes soft-deleted articles", (await Article.count()) === 1);

// --- scope ---
console.log("\n--- scope ---");
User.scope("adult", "age >= ?", [18]);
const adults = await (User as any).adult();
assert("scope creates a callable static method", Array.isArray(adults));
assert("scope returns rows matching SQL", adults.length === 3); // all three are >= 18

User.scope("over30", "age > ?", [30]);
const over30 = await (User as any).over30();
assert("scope filters correctly", over30.length === 1 && (over30[0] as any).name === "Charlie");

// --- seedOrm against a real ORM class ---
console.log("\n--- seedOrm against real class ---");
class Widget extends BaseModel {
  static tableName = "widgets";
  static fields: Record<string, FieldDefinition> = {
    id:    { type: "integer", primaryKey: true, autoIncrement: true },
    name:  { type: "string", required: true, maxLength: 50 },
    price: { type: "number", min: 1, max: 1000 },
  };
}
const widgetModel: DiscoveredModel = {
  definition: { tableName: "widgets", fields: Widget.fields },
  filePath: "test",
  modelClass: Widget,
};
await syncModels([widgetModel]);

const inserted = (await seedOrm(Widget as any, 7, undefined, 42)).seeded;
assert("seedOrm returns count inserted", inserted === 7);
assert("seedOrm produced rows in the table", (await Widget.count()) === 7);

// Overrides applied to every row
const inserted2 = (await seedOrm(Widget as any, 3, { name: "FixedName" }, 42)).seeded;
assert("seedOrm with overrides returns count", inserted2 === 3);
// all() no longer takes a filter (3.13.95 parity) -- that is where()'s job.
const fixed = await Widget.where('name = ?', ["FixedName"]);
assert("seedOrm overrides land in the database", fixed.length === 3);

// Determinism with seed
class Gadget extends BaseModel {
  static tableName = "gadgets";
  static fields: Record<string, FieldDefinition> = {
    id:   { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string", maxLength: 50 },
  };
}
const gadgetModel: DiscoveredModel = {
  definition: { tableName: "gadgets", fields: Gadget.fields },
  filePath: "test",
  modelClass: Gadget,
};
await syncModels([gadgetModel]);

await seedOrm(Gadget as any, 5, undefined, 123);
const firstRun = (await Gadget.all()).map((g: any) => g.name);

// Wipe and reseed with same seed
getAdapter().execute(`DELETE FROM "gadgets"`);
await seedOrm(Gadget as any, 5, undefined, 123);
const secondRun = (await Gadget.all()).map((g: any) => g.name);

assert(
  "seedOrm with the same seed produces the same rows",
  JSON.stringify(firstRun) === JSON.stringify(secondRun),
);

// Cleanup
closeDatabase();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
