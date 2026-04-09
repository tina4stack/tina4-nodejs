/**
 * Unit tests for the SQL Translation module (cross-engine SQL translator + query cache).
 * Run with: npx tsx test/sqlTranslation.test.ts
 */
import { SQLTranslator, QueryCache } from "../packages/orm/src/sqlTranslation.ts";

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

console.log("=== SQL Translation Tests ===\n");

// --- limitToRows ---
console.log("--- limitToRows (Firebird) ---");

assert(
  "LIMIT/OFFSET → ROWS X TO Y",
  SQLTranslator.limitToRows("SELECT * FROM users LIMIT 10 OFFSET 5") === "SELECT * FROM users ROWS 6 TO 15",
);

assert(
  "LIMIT only → ROWS 1 TO N",
  SQLTranslator.limitToRows("SELECT * FROM users LIMIT 10") === "SELECT * FROM users ROWS 1 TO 10",
);

assert(
  "no LIMIT → unchanged",
  SQLTranslator.limitToRows("SELECT * FROM users") === "SELECT * FROM users",
);

assert(
  "LIMIT/OFFSET case insensitive",
  SQLTranslator.limitToRows("SELECT * FROM users limit 5 offset 10") === "SELECT * FROM users ROWS 11 TO 15",
);

assert(
  "LIMIT 1 → ROWS 1 TO 1",
  SQLTranslator.limitToRows("SELECT * FROM users LIMIT 1") === "SELECT * FROM users ROWS 1 TO 1",
);

assert(
  "LIMIT 0 OFFSET 0 → ROWS 1 TO 0",
  SQLTranslator.limitToRows("SELECT * FROM users LIMIT 0 OFFSET 0") === "SELECT * FROM users ROWS 1 TO 0",
);

// --- limitToTop ---
console.log("\n--- limitToTop (MSSQL) ---");

assert(
  "LIMIT → TOP",
  SQLTranslator.limitToTop("SELECT * FROM users LIMIT 10") === "SELECT TOP 10 * FROM users",
);

assert(
  "no LIMIT → unchanged",
  SQLTranslator.limitToTop("SELECT * FROM users") === "SELECT * FROM users",
);

assert(
  "LIMIT with OFFSET → unchanged (TOP does not support OFFSET)",
  SQLTranslator.limitToTop("SELECT * FROM users LIMIT 10 OFFSET 5") === "SELECT * FROM users LIMIT 10 OFFSET 5",
);

assert(
  "case insensitive select",
  SQLTranslator.limitToTop("select name from users LIMIT 5") === "select TOP 5 name from users",
);

// --- booleanToInt ---
console.log("\n--- booleanToInt (Firebird) ---");

assert(
  "TRUE → 1",
  SQLTranslator.booleanToInt("SELECT * FROM users WHERE active = TRUE") === "SELECT * FROM users WHERE active = 1",
);

assert(
  "FALSE → 0",
  SQLTranslator.booleanToInt("UPDATE users SET active = FALSE WHERE id = 1") === "UPDATE users SET active = 0 WHERE id = 1",
);

assert(
  "both TRUE and FALSE",
  SQLTranslator.booleanToInt("SELECT TRUE, FALSE") === "SELECT 1, 0",
);

assert(
  "case insensitive",
  SQLTranslator.booleanToInt("SELECT * WHERE active = true AND deleted = false") === "SELECT * WHERE active = 1 AND deleted = 0",
);

assert(
  "no booleans → unchanged",
  SQLTranslator.booleanToInt("SELECT * FROM users WHERE id = 1") === "SELECT * FROM users WHERE id = 1",
);

// --- placeholderStyle ---
console.log("\n--- placeholderStyle ---");

assert(
  "? → :1, :2, :3",
  SQLTranslator.placeholderStyle("SELECT * FROM users WHERE id = ? AND name = ?", ":") === "SELECT * FROM users WHERE id = :1 AND name = :2",
);

assert(
  "? → %s",
  SQLTranslator.placeholderStyle("INSERT INTO t (a, b) VALUES (?, ?)", "%s") === "INSERT INTO t (a, b) VALUES (%s, %s)",
);

assert(
  "no placeholders → unchanged",
  SQLTranslator.placeholderStyle("SELECT * FROM users", ":") === "SELECT * FROM users",
);

assert(
  "single placeholder",
  SQLTranslator.placeholderStyle("DELETE FROM t WHERE id = ?", ":") === "DELETE FROM t WHERE id = :1",
);

// --- concatPipesToFunc ---
console.log("\n--- concatPipesToFunc ---");

const concatResult = SQLTranslator.concatPipesToFunc("'a' || 'b' || 'c'");
assert("pipes → CONCAT()", concatResult === "CONCAT('a', 'b', 'c')");

assert(
  "no pipes → unchanged",
  SQLTranslator.concatPipesToFunc("SELECT * FROM users") === "SELECT * FROM users",
);

// --- ilikeToLike ---
console.log("\n--- ilikeToLike ---");

const ilikeResult = SQLTranslator.ilikeToLike("SELECT * FROM users WHERE name ILIKE '%alice%'");
assert("ILIKE → LOWER() LIKE LOWER()", ilikeResult.includes("LOWER(name)") && ilikeResult.includes("LIKE LOWER"));

// --- autoIncrementSyntax ---
console.log("\n--- autoIncrementSyntax ---");

const ddl = "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)";

assert(
  "MySQL: AUTOINCREMENT → AUTO_INCREMENT",
  SQLTranslator.autoIncrementSyntax(ddl, "mysql").includes("AUTO_INCREMENT"),
);

assert(
  "PostgreSQL: INTEGER PK AUTOINCREMENT → SERIAL PK",
  SQLTranslator.autoIncrementSyntax(ddl, "postgresql").includes("SERIAL PRIMARY KEY"),
);

assert(
  "MSSQL: AUTOINCREMENT → IDENTITY(1,1)",
  SQLTranslator.autoIncrementSyntax(ddl, "mssql").includes("IDENTITY(1,1)"),
);

assert(
  "Firebird: removes AUTOINCREMENT",
  !SQLTranslator.autoIncrementSyntax(ddl, "firebird").includes("AUTOINCREMENT"),
);

assert(
  "unknown engine → unchanged",
  SQLTranslator.autoIncrementSyntax(ddl, "unknown") === ddl,
);

// --- parseReturning ---
console.log("\n--- parseReturning ---");

const retResult = SQLTranslator.parseReturning("INSERT INTO t (x) VALUES (1) RETURNING id, name");
assert("parseReturning extracts SQL", retResult.sql === "INSERT INTO t (x) VALUES (1)");
assert("parseReturning extracts columns", retResult.columns.length === 2);
assert("parseReturning column 0", retResult.columns[0] === "id");
assert("parseReturning column 1", retResult.columns[1] === "name");

const noRet = SQLTranslator.parseReturning("INSERT INTO t (x) VALUES (1)");
assert("no RETURNING → empty columns", noRet.columns.length === 0);
assert("no RETURNING → sql unchanged", noRet.sql === "INSERT INTO t (x) VALUES (1)");

// --- QueryCache ---
console.log("\n--- QueryCache ---");

const cache = new QueryCache({ defaultTtl: 2, maxSize: 5 });

assert("new cache has size 0", cache.size() === 0);

cache.set("key1", "value1");
assert("set then get returns value", cache.get<string>("key1") === "value1");
assert("size is 1 after set", cache.size() === 1);
assert("has returns true for existing key", cache.has("key1"));
assert("has returns false for missing key", !cache.has("missing"));

cache.set("key2", 42);
assert("get number value", cache.get<number>("key2") === 42);

assert("get missing key returns undefined", cache.get("missing") === undefined);

// --- QueryCache delete ---
console.log("\n--- QueryCache delete ---");

cache.delete("key1");
assert("deleted key returns undefined", cache.get("key1") === undefined);
assert("size decreases after delete", cache.size() === 1);

// --- QueryCache clear ---
console.log("\n--- QueryCache clear ---");

cache.set("a", 1);
cache.set("b", 2);
cache.clear();
assert("clear empties cache", cache.size() === 0);

// --- QueryCache maxSize eviction ---
console.log("\n--- QueryCache maxSize eviction ---");

const smallCache = new QueryCache({ maxSize: 3 });
smallCache.set("a", 1);
smallCache.set("b", 2);
smallCache.set("c", 3);
smallCache.set("d", 4); // should evict oldest
assert("cache size stays at maxSize", smallCache.size() <= 3);

// --- QueryCache remember ---
console.log("\n--- QueryCache remember ---");

const remCache = new QueryCache({ defaultTtl: 60 });
let factoryCalls = 0;
const val1 = remCache.remember("rkey", 60, () => { factoryCalls++; return "computed"; });
assert("remember returns factory result", val1 === "computed");
assert("factory called once", factoryCalls === 1);

const val2 = remCache.remember("rkey", 60, () => { factoryCalls++; return "different"; });
assert("remember returns cached value on second call", val2 === "computed");
assert("factory not called again", factoryCalls === 1);

// --- QueryCache.queryKey ---
console.log("\n--- QueryCache.queryKey ---");

const qk1 = QueryCache.queryKey("SELECT * FROM users", [1, "alice"]);
const qk2 = QueryCache.queryKey("SELECT * FROM users", [1, "alice"]);
const qk3 = QueryCache.queryKey("SELECT * FROM users", [2, "bob"]);

assert("same query+params → same key", qk1 === qk2);
assert("different params → different key", qk1 !== qk3);

const qkNoParams = QueryCache.queryKey("SELECT 1");
assert("queryKey without params works", typeof qkNoParams === "string" && qkNoParams.length > 0);

// --- QueryCache TTL expiry ---
console.log("\n--- QueryCache TTL expiry ---");

const ttlCache = new QueryCache({ defaultTtl: 60 });
ttlCache.set("expires", "soon", 0.001); // 1ms TTL

// Wait a bit for expiry
const start = Date.now();
while (Date.now() - start < 10) {} // busy wait 10ms

assert("expired entry returns undefined", ttlCache.get("expires") === undefined);

// --- QueryCache clearTag ---
console.log("\n--- QueryCache clearTag ---");

const tagCache = new QueryCache({ defaultTtl: 60 });
tagCache.set("a", 1, 60, ["users", "list"]);
tagCache.set("b", 2, 60, ["users"]);
tagCache.set("c", 3, 60, ["products"]);

const taggedRemoved = tagCache.clearTag("users");
assert("clearTag removes correct count", taggedRemoved === 2);
assert("clearTag removed 'a'", tagCache.get("a") === undefined);
assert("clearTag removed 'b'", tagCache.get("b") === undefined);
assert("clearTag kept 'c'", tagCache.get("c") === 3);

// --- QueryCache sweep ---
console.log("\n--- QueryCache sweep ---");

const sweepCache = new QueryCache({ defaultTtl: 60 });
sweepCache.set("fresh", "data", 3600);
sweepCache.set("stale1", "old", 0.001);
sweepCache.set("stale2", "old", 0.001);

const startSweep = Date.now();
while (Date.now() - startSweep < 10) {}

const removed = sweepCache.sweep();
assert("sweep removes expired entries", removed >= 2);
assert("fresh entry survives sweep", sweepCache.get("fresh") === "data");

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
