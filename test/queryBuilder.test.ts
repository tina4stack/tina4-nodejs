/**
 * Comprehensive tests for QueryBuilder.
 * Run with: npx tsx test/queryBuilder.test.ts
 */
import { QueryBuilder, SQLiteAdapter } from "../packages/orm/src/index.ts";
import type { DatabaseAdapter } from "../packages/orm/src/types.ts";

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

// --- Setup: in-memory SQLite with a users table and 5 rows ---
const db: DatabaseAdapter = new SQLiteAdapter(":memory:");
db.execute(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    age INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'user'
  )
`);
db.execute(`
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

db.execute("INSERT INTO users (name, email, age, role) VALUES (?, ?, ?, ?)", ["Alice", "alice@example.com", 30, "admin"]);
db.execute("INSERT INTO users (name, email, age, role) VALUES (?, ?, ?, ?)", ["Bob", "bob@example.com", 25, "user"]);
db.execute("INSERT INTO users (name, email, age, role) VALUES (?, ?, ?, ?)", ["Charlie", "charlie@example.com", 35, "user"]);
db.execute("INSERT INTO users (name, email, age, role) VALUES (?, ?, ?, ?)", ["Diana", "diana@example.com", 28, "admin"]);
db.execute("INSERT INTO users (name, email, age, role) VALUES (?, ?, ?, ?)", ["Eve", "eve@example.com", 22, "user"]);

db.execute("INSERT INTO orders (user_id, amount) VALUES (?, ?)", [1, 100.00]);
db.execute("INSERT INTO orders (user_id, amount) VALUES (?, ?)", [1, 250.50]);
db.execute("INSERT INTO orders (user_id, amount) VALUES (?, ?)", [2, 75.00]);
db.execute("INSERT INTO orders (user_id, amount) VALUES (?, ?)", [3, 300.00]);

console.log("=== QueryBuilder Tests ===\n");

// ---------- 1. from() creates a QueryBuilder ----------
console.log("--- 1. from() creates a QueryBuilder ---");
{
  const qb = QueryBuilder.from("users", db);
  assert("from() returns a QueryBuilder instance", qb instanceof QueryBuilder);
  assert("from() without db returns a QueryBuilder", QueryBuilder.from("users") instanceof QueryBuilder);
}

// ---------- 2. select() sets columns ----------
console.log("\n--- 2. select() sets columns ---");
{
  const sql = QueryBuilder.from("users").select("id", "name").toSql();
  assert("select() sets specific columns", sql === "SELECT id, name FROM users");

  const sqlDefault = QueryBuilder.from("users").toSql();
  assert("default select is *", sqlDefault === "SELECT * FROM users");

  const sqlEmpty = QueryBuilder.from("users").select().toSql();
  assert("select() with no args keeps *", sqlEmpty === "SELECT * FROM users");
}

// ---------- 3. where() adds AND conditions ----------
console.log("\n--- 3. where() adds AND conditions ---");
{
  const sql = QueryBuilder.from("users").where("age > ?", [18]).toSql();
  assert("single where()", sql === "SELECT * FROM users WHERE age > ?");

  const sql2 = QueryBuilder.from("users")
    .where("age > ?", [18])
    .where("role = ?", ["admin"])
    .toSql();
  assert("multiple where() adds AND", sql2 === "SELECT * FROM users WHERE age > ? AND role = ?");
}

// ---------- 4. orWhere() adds OR conditions ----------
console.log("\n--- 4. orWhere() adds OR conditions ---");
{
  const sql = QueryBuilder.from("users")
    .where("role = ?", ["admin"])
    .orWhere("role = ?", ["user"])
    .toSql();
  assert("orWhere() adds OR", sql === "SELECT * FROM users WHERE role = ? OR role = ?");
}

// ---------- 5. join() adds INNER JOIN ----------
console.log("\n--- 5. join() adds INNER JOIN ---");
{
  const sql = QueryBuilder.from("users")
    .join("orders", "orders.user_id = users.id")
    .toSql();
  assert("join() adds INNER JOIN", sql === "SELECT * FROM users INNER JOIN orders ON orders.user_id = users.id");
}

// ---------- 6. leftJoin() adds LEFT JOIN ----------
console.log("\n--- 6. leftJoin() adds LEFT JOIN ---");
{
  const sql = QueryBuilder.from("users")
    .leftJoin("orders", "orders.user_id = users.id")
    .toSql();
  assert("leftJoin() adds LEFT JOIN", sql === "SELECT * FROM users LEFT JOIN orders ON orders.user_id = users.id");
}

// ---------- 7. groupBy() adds GROUP BY ----------
console.log("\n--- 7. groupBy() adds GROUP BY ---");
{
  const sql = QueryBuilder.from("users").groupBy("role").toSql();
  assert("groupBy() single column", sql === "SELECT * FROM users GROUP BY role");

  const sql2 = QueryBuilder.from("users").groupBy("role").groupBy("age").toSql();
  assert("groupBy() multiple columns", sql2 === "SELECT * FROM users GROUP BY role, age");
}

// ---------- 8. having() adds HAVING ----------
console.log("\n--- 8. having() adds HAVING ---");
{
  const sql = QueryBuilder.from("users")
    .select("role", "COUNT(*) as cnt")
    .groupBy("role")
    .having("cnt > ?", [1])
    .toSql();
  assert("having() adds HAVING clause", sql === "SELECT role, COUNT(*) as cnt FROM users GROUP BY role HAVING cnt > ?");
}

// ---------- 9. orderBy() adds ORDER BY ----------
console.log("\n--- 9. orderBy() adds ORDER BY ---");
{
  const sql = QueryBuilder.from("users").orderBy("name ASC").toSql();
  assert("orderBy() single", sql === "SELECT * FROM users ORDER BY name ASC");

  const sql2 = QueryBuilder.from("users").orderBy("name ASC").orderBy("age DESC").toSql();
  assert("orderBy() multiple", sql2 === "SELECT * FROM users ORDER BY name ASC, age DESC");
}

// ---------- 10. limit() sets LIMIT and OFFSET ----------
console.log("\n--- 10. limit() sets LIMIT and OFFSET ---");
{
  // Note: limit/offset are not appended to toSql() — they're passed to fetch().
  // Verify toSql() output is correct (no LIMIT in SQL string).
  const qb = QueryBuilder.from("users", db).limit(3, 1);
  const sql = qb.toSql();
  assert("limit() does not append to SQL (passed to fetch)", sql === "SELECT * FROM users");

  // Verify limit actually works via get()
  const rows = qb.get();
  assert("limit(3, 1) returns 3 rows skipping 1", rows.length === 3);
}

// ---------- 11. toSql() generates correct SQL ----------
console.log("\n--- 11. toSql() generates correct SQL ---");
{
  const sql = QueryBuilder.from("users")
    .select("users.name", "orders.amount")
    .join("orders", "orders.user_id = users.id")
    .where("users.age > ?", [20])
    .groupBy("users.name")
    .having("SUM(orders.amount) > ?", [50])
    .orderBy("users.name ASC")
    .toSql();

  const expected =
    "SELECT users.name, orders.amount FROM users " +
    "INNER JOIN orders ON orders.user_id = users.id " +
    "WHERE users.age > ? " +
    "GROUP BY users.name " +
    "HAVING SUM(orders.amount) > ? " +
    "ORDER BY users.name ASC";
  assert("toSql() full query", sql === expected, `got: ${sql}`);
}

// ---------- 12. Method chaining returns this ----------
console.log("\n--- 12. Method chaining returns this ---");
{
  const qb = QueryBuilder.from("users");
  assert("select() returns same instance", qb.select("id") === qb);
  assert("where() returns same instance", qb.where("id = ?", [1]) === qb);
  assert("orWhere() returns same instance", qb.orWhere("id = ?", [2]) === qb);
  assert("join() returns same instance", qb.join("orders", "orders.user_id = users.id") === qb);
  assert("leftJoin() returns same instance", qb.leftJoin("orders", "orders.user_id = users.id") === qb);
  assert("groupBy() returns same instance", qb.groupBy("role") === qb);
  assert("having() returns same instance", qb.having("COUNT(*) > ?", [1]) === qb);
  assert("orderBy() returns same instance", qb.orderBy("name") === qb);
  assert("limit() returns same instance", qb.limit(10) === qb);
}

// ---------- 13. get() returns results ----------
console.log("\n--- 13. get() returns results ---");
{
  const rows = QueryBuilder.from("users", db).get();
  assert("get() returns all 5 users", rows.length === 5);
  assert("get() returns objects with name", (rows[0] as any).name === "Alice");

  const filtered = QueryBuilder.from("users", db)
    .where("role = ?", ["admin"])
    .get();
  assert("get() with where returns filtered rows", filtered.length === 2);

  const selected = QueryBuilder.from("users", db)
    .select("name", "email")
    .where("id = ?", [1])
    .get();
  assert("get() with select returns correct columns", (selected[0] as any).name === "Alice");
  assert("get() with select has email", (selected[0] as any).email === "alice@example.com");
}

// ---------- 14. first() returns single record or null ----------
console.log("\n--- 14. first() returns single record or null ---");
{
  const row = QueryBuilder.from("users", db)
    .where("id = ?", [1])
    .first();
  assert("first() returns a record", row !== null);
  assert("first() returns correct record", (row as any).name === "Alice");

  const noRow = QueryBuilder.from("users", db)
    .where("id = ?", [999])
    .first();
  assert("first() returns null for no match", noRow === null);
}

// ---------- 15. count() returns number ----------
console.log("\n--- 15. count() returns number ---");
{
  const total = QueryBuilder.from("users", db).count();
  assert("count() returns total rows", total === 5);

  const adminCount = QueryBuilder.from("users", db)
    .where("role = ?", ["admin"])
    .count();
  assert("count() with where returns filtered count", adminCount === 2);

  const userCount = QueryBuilder.from("users", db)
    .where("role = ?", ["user"])
    .count();
  assert("count() user role returns 3", userCount === 3);
}

// ---------- 16. exists() returns boolean ----------
console.log("\n--- 16. exists() returns boolean ---");
{
  const hasUsers = QueryBuilder.from("users", db).exists();
  assert("exists() returns true when rows exist", hasUsers === true);

  const hasNone = QueryBuilder.from("users", db)
    .where("age > ?", [100])
    .exists();
  assert("exists() returns false when no rows match", hasNone === false);
}

// ---------- 17. No database throws error ----------
console.log("\n--- 17. No database throws error ---");
{
  let threw = false;
  try {
    QueryBuilder.from("users").get();
  } catch (e: any) {
    threw = true;
    assert("error message mentions no adapter", e.message.includes("No database adapter"));
  }
  assert("get() without db throws", threw);

  let threwFirst = false;
  try {
    QueryBuilder.from("users").first();
  } catch {
    threwFirst = true;
  }
  assert("first() without db throws", threwFirst);

  let threwCount = false;
  try {
    QueryBuilder.from("users").count();
  } catch {
    threwCount = true;
  }
  assert("count() without db throws", threwCount);

  let threwExists = false;
  try {
    QueryBuilder.from("users").exists();
  } catch {
    threwExists = true;
  }
  assert("exists() without db throws", threwExists);
}

// ---------- 18. Complex multi-clause query ----------
console.log("\n--- 18. Complex multi-clause query ---");
{
  // Build a complex query and verify both SQL and results
  const sql = QueryBuilder.from("users")
    .select("users.name", "SUM(orders.amount) as total")
    .join("orders", "orders.user_id = users.id")
    .where("users.age >= ?", [25])
    .orWhere("users.role = ?", ["admin"])
    .groupBy("users.name")
    .having("total > ?", [50])
    .orderBy("total DESC")
    .toSql();

  const expected =
    "SELECT users.name, SUM(orders.amount) as total FROM users " +
    "INNER JOIN orders ON orders.user_id = users.id " +
    "WHERE users.age >= ? OR users.role = ? " +
    "GROUP BY users.name " +
    "HAVING total > ? " +
    "ORDER BY total DESC";
  assert("complex SQL is correct", sql === expected, `got: ${sql}`);

  // Execute the complex query
  const rows = QueryBuilder.from("users", db)
    .select("users.name", "SUM(orders.amount) as total")
    .join("orders", "orders.user_id = users.id")
    .where("users.age >= ?", [25])
    .groupBy("users.name")
    .having("SUM(orders.amount) > ?", [50])
    .orderBy("total DESC")
    .get();
  assert("complex query executes without error", Array.isArray(rows));
  assert("complex query returns results", rows.length > 0);
}

// ---------- 19. Empty results ----------
console.log("\n--- 19. Empty results ---");
{
  const rows = QueryBuilder.from("users", db)
    .where("age > ?", [200])
    .get();
  assert("get() returns empty array for no matches", Array.isArray(rows) && rows.length === 0);

  const first = QueryBuilder.from("users", db)
    .where("age > ?", [200])
    .first();
  assert("first() returns null for no matches", first === null);

  const cnt = QueryBuilder.from("users", db)
    .where("age > ?", [200])
    .count();
  assert("count() returns 0 for no matches", cnt === 0);

  const exists = QueryBuilder.from("users", db)
    .where("age > ?", [200])
    .exists();
  assert("exists() returns false for no matches", exists === false);
}

// ---------- Bonus: left join with null rows ----------
console.log("\n--- Bonus: LEFT JOIN includes unmatched rows ---");
{
  const rows = QueryBuilder.from("users", db)
    .select("users.name", "orders.amount")
    .leftJoin("orders", "orders.user_id = users.id")
    .orderBy("users.name ASC")
    .get();
  // Eve and Diana have no orders; all 5 users should still appear
  const names = rows.map((r: any) => r.name);
  assert("left join includes users without orders", names.includes("Eve"));
  assert("left join returns at least 5 rows (some users have multiple orders)", rows.length >= 5);
}

// ---------- Bonus: where with no params ----------
console.log("\n--- Bonus: where() with no params ---");
{
  const sql = QueryBuilder.from("users").where("active = 1").toSql();
  assert("where() works without params array", sql === "SELECT * FROM users WHERE active = 1");
}

// --- Summary ---
console.log(`\n=== QueryBuilder Results: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
