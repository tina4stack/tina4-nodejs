/**
 * Product-name seeding — a generic `name` column on a product-ish table/model
 * gets product names ("Wireless Keyboard"), not person names ("John Smith").
 * Ported from the proven Python reference (tests/test_seeder_product_names.py).
 *
 * No mocks: the integration section seeds a REAL in-memory SQLite table/model
 * (node:sqlite via createAdapterFromUrl) and reads the rows back. The heuristic
 * section calls the real forField()/isProductTable() over real strings (pure, no
 * dependency). Product and person vocabularies are disjoint, so the FIRST word of
 * a generated value tells which generator ran.
 *
 * Run with: npx tsx test/seederProductNames.test.ts
 */
import { FakeData, isProductTable } from "../packages/orm/src/fakeData.ts";
import { PRODUCT_ADJECTIVES, FIRST_NAMES, LAST_NAMES } from "../packages/core/src/fakeData.ts";
import { seedOrm, seedTable, autoFieldMap } from "../packages/orm/src/seeder.ts";
import { createAdapterFromUrl } from "../packages/orm/src/index.ts";
import type { FieldDefinition } from "../packages/orm/src/types.ts";

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

const PRODUCT_ADJ = new Set(PRODUCT_ADJECTIVES);
const PERSON_FIRST = new Set(FIRST_NAMES);
const PERSON_LAST = new Set(LAST_NAMES);

/** First whitespace-delimited word — the disambiguator (product noun phrases
 * like "Coffee Beans" are multi-word, but the FIRST word is always the adj). */
const firstWord = (v: unknown): string => String(v).split(" ")[0];

console.log("=== Product-Name Seeding Tests ===\n");

// ── TestProductGenerator ─────────────────────────────────────────
console.log("--- product() generator ---");

{
  const p = new FakeData(1).product();
  assert(
    "product() is 'adjective + noun' (first word is a product adjective)",
    PRODUCT_ADJ.has(firstWord(p)) && p.includes(" ") && p.split(" ").length >= 2,
    `got "${p}"`,
  );
}

{
  // A fresh seed-7 instance's first product() draw is identical every time.
  const a = [new FakeData(7).product(), new FakeData(7).product(), new FakeData(7).product()];
  const b = [new FakeData(7).product(), new FakeData(7).product(), new FakeData(7).product()];
  assert(
    "product() is deterministic under a seed",
    JSON.stringify(a) === JSON.stringify(b),
    `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
  );

  // ...and it varies across draws on one instance, not a single constant string.
  const f = new FakeData(3);
  const distinct = new Set(Array.from({ length: 30 }, () => f.product()));
  assert("product() varies across draws (not one constant)", distinct.size > 1, `distinct=${distinct.size}`);
}

{
  // A product's first word is never a person first-name and vice versa, which is
  // what makes the table-aware assertions below unambiguous.
  const overlap = [...PRODUCT_ADJ].filter((a) => PERSON_FIRST.has(a));
  assert("product adjectives are disjoint from person first-names", overlap.length === 0, `overlap=${JSON.stringify(overlap)}`);
}

// ── TestIsProductTable ───────────────────────────────────────────
console.log("\n--- isProductTable() helper ---");

for (const t of ["products", "Product", "order_items", "catalog", "inventory",
  "sku_table", "listings", "stock", "warehouse", "goods", "merchandise"]) {
  assert(`isProductTable("${t}") is true`, isProductTable(t) === true);
}

for (const t of ["users", "people", "customers", "employees", "orders"]) {
  assert(`isProductTable("${t}") is false`, isProductTable(t) === false);
}
assert('isProductTable(undefined) is false (back-compat)', isProductTable(undefined) === false);
assert('isProductTable(null) is false (back-compat)', isProductTable(null) === false);
assert('isProductTable("") is false (back-compat)', isProductTable("") === false);

// ── TestHeuristicIsTableAware ────────────────────────────────────
// Node collapses Python's THREE name->generator sites into ONE: forField().
// autoFieldMap and seedOrm both delegate to it, so this is the single heuristic
// site. It honours the table, and defaults to a person name with no table
// context (back-compat).
console.log("\n--- forField() name-column heuristic is table-aware ---");

{
  const meta: FieldDefinition = { type: "string" };

  const prod = new FakeData(1).forField(meta, "name", "products");
  assert("forField(name, table=products) -> product name", PRODUCT_ADJ.has(firstWord(prod)), `got "${prod}"`);

  const person = new FakeData(1).forField(meta, "name", "users");
  assert("forField(name, table=users) -> person name", PERSON_FIRST.has(firstWord(person)), `got "${person}"`);

  const backCompat = new FakeData(1).forField(meta, "name");
  assert("forField(name) with NO table -> person name (back-compat)", PERSON_FIRST.has(firstWord(backCompat)), `got "${backCompat}"`);

  // full_name / fullname get the same treatment as name.
  const fullProd = new FakeData(1).forField(meta, "full_name", "inventory");
  assert("forField(full_name, table=inventory) -> product name", PRODUCT_ADJ.has(firstWord(fullProd)), `got "${fullProd}"`);
  const fullPerson = new FakeData(1).forField(meta, "fullname", "employees");
  assert("forField(fullname, table=employees) -> person name", PERSON_FIRST.has(firstWord(fullPerson)), `got "${fullPerson}"`);
}

{
  // first_name / last_name / username stay person-ish EVEN on a product table —
  // the product logic only touches the generic name/full_name column.
  const meta: FieldDefinition = { type: "string" };

  const firstName = new FakeData(1).forField(meta, "first_name", "products");
  assert("forField(first_name) stays a person first-name on a product table", PERSON_FIRST.has(firstWord(firstName)), `got "${firstName}"`);

  const lastName = new FakeData(1).forField(meta, "last_name", "products");
  assert("forField(last_name) stays a person last-name on a product table",
    PERSON_LAST.has(firstWord(lastName)) && !PRODUCT_ADJ.has(firstWord(lastName)), `got "${lastName}"`);

  const userName = new FakeData(1).forField(meta, "username", "products");
  assert("forField(username) is never a product on a product table", !PRODUCT_ADJ.has(firstWord(userName)), `got "${userName}"`);
}

// ── TestRealSeeding (real in-memory SQLite, no mocks) ────────────
console.log("\n--- Real SQLite seeding ---");

// 1. seedOrm on a PRODUCT model — the name column fills with product names.
{
  const db = await createAdapterFromUrl("sqlite:///:memory:");
  db.execute(`CREATE TABLE product (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  const productModel = {
    name: "Product",
    tableName: "product",
    fields: {
      id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
      name: { type: "string" as const },
    },
    getDb: () => db,
  };
  await seedOrm(productModel, 8, undefined, 42);
  const rows = db.fetch<{ name: string }>("SELECT name FROM product ORDER BY id");
  assert("seedOrm product model wrote 8 real rows", rows.length === 8, `rows=${rows.length}`);
  assert(
    "every seeded product.name is a product name",
    rows.length === 8 && rows.every((r) => PRODUCT_ADJ.has(firstWord(r.name))),
    JSON.stringify(rows.map((r) => r.name)),
  );
  db.close?.();
}

// 2. seedOrm on a USER model — the SAME name column fills with person names
//    (the negative case that proves it is table-driven, not global).
{
  const db = await createAdapterFromUrl("sqlite:///:memory:");
  db.execute(`CREATE TABLE user (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
  const userModel = {
    name: "User",
    tableName: "user",
    fields: {
      id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
      name: { type: "string" as const },
    },
    getDb: () => db,
  };
  await seedOrm(userModel, 8, undefined, 42);
  const rows = db.fetch<{ name: string }>("SELECT name FROM user ORDER BY id");
  assert("seedOrm user model wrote 8 real rows", rows.length === 8, `rows=${rows.length}`);
  assert(
    "every seeded user.name is a person name",
    rows.length === 8 && rows.every((r) => PERSON_FIRST.has(firstWord(r.name))),
    JSON.stringify(rows.map((r) => r.name)),
  );
  db.close?.();
}

// 3. autoFieldMap + seedTable on a `products` table — the introspection path
//    (dev-admin + MCP seed tools) threads the table name into forField.
{
  const db = await createAdapterFromUrl("sqlite:///:memory:");
  db.execute(`CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price REAL)`);
  const fake = new FakeData(5);
  const map = await autoFieldMap(db, "products", fake);
  await seedTable(db, "products", 8, map);
  const rows = db.fetch<{ name: string }>("SELECT name FROM products ORDER BY id");
  assert("autoFieldMap+seedTable wrote 8 real rows", rows.length === 8, `rows=${rows.length}`);
  assert(
    "autoFieldMap seeds a products table's name column with product names",
    rows.length === 8 && rows.every((r) => PRODUCT_ADJ.has(firstWord(r.name))),
    JSON.stringify(rows.map((r) => r.name)),
  );
  db.close?.();
}

// 4. Reproducible with a seed — same seed -> same product names in two
//    independent databases.
{
  async function run(): Promise<string[]> {
    const db = await createAdapterFromUrl("sqlite:///:memory:");
    db.execute(`CREATE TABLE item (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`);
    const itemModel = {
      name: "Item",
      tableName: "item",
      fields: {
        id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
        name: { type: "string" as const },
      },
      getDb: () => db,
    };
    await seedOrm(itemModel, 6, undefined, 99);
    const names = db.fetch<{ name: string }>("SELECT name FROM item ORDER BY id").map((r) => r.name);
    db.close?.();
    return names;
  }
  const a = await run();
  const b = await run();
  assert(
    "seedOrm product names are reproducible under the same seed",
    a.length === 6 && JSON.stringify(a) === JSON.stringify(b) && a.every((n) => PRODUCT_ADJ.has(firstWord(n))),
    `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
  );
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
