/**
 * Database Drivers Tests — adapter registration, missing package errors, SQL translation.
 * Run with: npx tsx test/databaseDrivers.test.ts
 *
 * Tests that need running databases are skipped by default.
 */
import { parseDatabaseUrl, setAdapter, getAdapter, closeDatabase, SQLTranslator, CachedDatabaseAdapter } from "../packages/orm/src/index.ts";
import { SQLiteAdapter } from "../packages/orm/src/adapters/sqlite.ts";
import { PostgresAdapter } from "../packages/orm/src/adapters/postgres.ts";
import { MysqlAdapter } from "../packages/orm/src/adapters/mysql.ts";
import { MssqlAdapter } from "../packages/orm/src/adapters/mssql.ts";
import { FirebirdAdapter } from "../packages/orm/src/adapters/firebird.ts";
import { mkdirSync, rmSync } from "node:fs";

let pass = 0;
let fail = 0;
let skipped = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function skip(name: string, reason: string) {
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${reason}`);
  skipped++;
}

console.log("=== Database Drivers Tests ===\n");

// ── Adapter Registration ─────────────────────────────────────

console.log("--- Adapter Registration ---");

const testDbPath = "/tmp/tina4-driver-test/test.db";
mkdirSync("/tmp/tina4-driver-test", { recursive: true });

const sqlite = new SQLiteAdapter(testDbPath);
setAdapter(sqlite);
// Since v3.13.23 setAdapter() wraps the adapter with the query cache
// (CachedDatabaseAdapter, ON by default), so getAdapter() returns the wrapper.
// Unwrap one level to compare against the raw adapter we created.
const registered = getAdapter();
const unwrapped = registered instanceof CachedDatabaseAdapter ? registered.getAdapter() : registered;
assert("SQLiteAdapter registered as default (cache-wrapped)", unwrapped === sqlite);

// Beyond identity: prove the REGISTERED adapter (the cache wrapper returned by
// getAdapter()) is the real I/O path, not just === the raw instance. Create a
// table on the raw adapter, then round-trip a row entirely through getAdapter():
// insert via the wrapper, read it back via the wrapper, and confirm the bytes
// landed in the underlying SQLite file (visible to the raw adapter too).
sqlite.createTable("driver_reg", {
  id: { type: "integer", primaryKey: true, autoIncrement: true },
  name: { type: "string", required: true },
});
const regAdapter = getAdapter();
const regInsert = regAdapter.insert("driver_reg", { name: "Reg" });
assert("Registered adapter insert succeeds via getAdapter()", regInsert.success);
const regRow = regAdapter.fetchOne("SELECT name FROM driver_reg WHERE name = ?", ["Reg"]) as { name: string } | null;
assert("Registered adapter row round-trips through wrapper", regRow !== null && regRow.name === "Reg");
// The write must be visible on the underlying raw adapter — proving the wrapper
// delegated real I/O to the registered SQLiteAdapter, not a detached cache.
const rawRow = sqlite.fetchOne("SELECT name FROM driver_reg WHERE name = ?", ["Reg"]) as { name: string } | null;
assert("Wrapper write is visible on the underlying registered adapter", rawRow !== null && rawRow.name === "Reg");

// Test the expanded interface methods on SQLite
sqlite.createTable("driver_test", {
  id: { type: "integer", primaryKey: true, autoIncrement: true },
  name: { type: "string", required: true },
  active: { type: "boolean", default: true },
});

assert("SQLite tableExists", sqlite.tableExists("driver_test"));
assert("SQLite tables() lists table", sqlite.tables().includes("driver_test"));

const cols = sqlite.columns("driver_test");
assert("SQLite columns() returns columns", cols.length === 3);
assert("SQLite columns() has id", cols.some((c) => c.name === "id"));
assert("SQLite columns() has primaryKey flag", cols.some((c) => c.name === "id" && c.primaryKey === true));

// Test insert
const insertResult = sqlite.insert("driver_test", { name: "Alice", active: 1 });
assert("SQLite insert success", insertResult.success);
assert("SQLite insert lastInsertId", insertResult.lastInsertId !== undefined && insertResult.lastInsertId !== null);

// Test fetch / fetchOne
const rows = sqlite.fetch("SELECT * FROM driver_test WHERE name = ?", ["Alice"]);
assert("SQLite fetch returns rows", rows.length === 1);

const oneRow = sqlite.fetchOne("SELECT * FROM driver_test WHERE name = ?", ["Alice"]);
assert("SQLite fetchOne returns row", oneRow !== null && (oneRow as any).name === "Alice");

const noRow = sqlite.fetchOne("SELECT * FROM driver_test WHERE name = ?", ["Nobody"]);
assert("SQLite fetchOne returns null for no match", noRow === null);

// Test fetch with pagination
sqlite.insert("driver_test", { name: "Bob", active: 1 });
sqlite.insert("driver_test", { name: "Charlie", active: 0 });
const paginated = sqlite.fetch("SELECT * FROM driver_test", [], 2, 0);
assert("SQLite fetch with limit", paginated.length === 2);
const page2 = sqlite.fetch("SELECT * FROM driver_test", [], 2, 2);
assert("SQLite fetch with skip", page2.length === 1);

// Test update
const updateResult = sqlite.update("driver_test", { name: "Alice Updated" }, { name: "Alice" });
assert("SQLite update success", updateResult.success);
assert("SQLite update rowsAffected", updateResult.rowsAffected === 1);

// Test delete
const deleteResult = sqlite.delete("driver_test", { name: "Alice Updated" });
assert("SQLite delete success", deleteResult.success);
assert("SQLite delete rowsAffected", deleteResult.rowsAffected === 1);

// Test transaction
sqlite.startTransaction();
sqlite.insert("driver_test", { name: "TransactionTest", active: 1 });
sqlite.rollback();
const afterRollback = sqlite.fetchOne("SELECT * FROM driver_test WHERE name = ?", ["TransactionTest"]);
assert("SQLite rollback undoes insert", afterRollback === null);

sqlite.startTransaction();
sqlite.insert("driver_test", { name: "CommitTest", active: 1 });
sqlite.commit();
const afterCommit = sqlite.fetchOne("SELECT * FROM driver_test WHERE name = ?", ["CommitTest"]);
assert("SQLite commit persists insert", afterCommit !== null);

// Test lastInsertId
sqlite.insert("driver_test", { name: "LastId", active: 1 });
const lid = sqlite.lastInsertId();
assert("SQLite lastInsertId returns number", lid !== null && typeof lid === "number" || typeof lid === "bigint");

closeDatabase();

// ── URL Parsing for New Schemes ──────────────────────────────

console.log("\n--- URL Parsing: MSSQL ---");

const mssql1 = parseDatabaseUrl("mssql://sa:password@dbhost:1433/mydb");
assert("mssql URL type", mssql1.type === "mssql");
assert("mssql URL host", mssql1.host === "dbhost");
assert("mssql URL port", mssql1.port === 1433);
assert("mssql URL user", mssql1.user === "sa");
assert("mssql URL password", mssql1.password === "password");
assert("mssql URL database", mssql1.database === "mydb");

const mssql2 = parseDatabaseUrl("sqlserver://admin:secret@localhost/testdb");
assert("sqlserver:// alias type", mssql2.type === "mssql");
assert("sqlserver:// alias user", mssql2.user === "admin");

console.log("\n--- URL Parsing: Firebird ---");

const fb1 = parseDatabaseUrl("firebird://SYSDBA:masterkey@localhost:3050/var/data/test.fdb");
assert("firebird URL type", fb1.type === "firebird");
assert("firebird URL host", fb1.host === "localhost");
assert("firebird URL port", fb1.port === 3050);
assert("firebird URL user", fb1.user === "SYSDBA");
assert("firebird URL database", fb1.database === "/var/data/test.fdb");

// ── Missing Package Errors ───────────────────────────────────

console.log("\n--- Missing Package Errors ---");

// PostgreSQL
try {
  const pg = new PostgresAdapter("postgresql://localhost/test");
  await pg.connect();
  skip("PostgreSQL missing package error", "pg package is installed");
} catch (e) {
  const msg = (e as Error).message;
  // If the message references pg + Install/requires we know it's the "missing package"
  // path we expected. Otherwise pg IS installed and the connect() failed for a
  // different reason (no server, auth, etc.) — that's a SKIP, not a FAIL.
  if (msg.includes("pg") && (msg.includes("Install") || msg.includes("requires"))) {
    assert("PostgreSQL missing package error", true);
  } else {
    skip("PostgreSQL missing package error", "pg package is installed");
  }
}

// MySQL
try {
  const my = new MysqlAdapter("mysql://localhost/test");
  await my.connect();
  skip("MySQL missing package error", "mysql2 package is installed");
} catch (e) {
  const msg = (e as Error).message;
  assert("MySQL missing package error", msg.includes("mysql2") && (msg.includes("Install") || msg.includes("requires")));
}

// MSSQL
try {
  const ms = new MssqlAdapter("mssql://localhost/test");
  await ms.connect();
  skip("MSSQL missing package error", "tedious package is installed");
} catch (e) {
  const msg = (e as Error).message;
  assert("MSSQL missing package error", msg.includes("tedious") && (msg.includes("Install") || msg.includes("requires")));
}

// Firebird
try {
  const fb = new FirebirdAdapter("firebird://localhost/test.fdb");
  await fb.connect();
  skip("Firebird missing package error", "node-firebird package is installed");
} catch (e) {
  const msg = (e as Error).message;
  assert("Firebird missing package error", msg.includes("node-firebird") && (msg.includes("Install") || msg.includes("requires")));
}

// ── SQL Translation per Dialect ──────────────────────────────

console.log("\n--- SQL Translation: Firebird ---");

assert("Firebird LIMIT to ROWS",
  SQLTranslator.limitToRows("SELECT * FROM users LIMIT 10 OFFSET 5") === "SELECT * FROM users ROWS 6 TO 15",
);

assert("Firebird LIMIT only to ROWS",
  SQLTranslator.limitToRows("SELECT * FROM users LIMIT 10") === "SELECT * FROM users ROWS 1 TO 10",
);

assert("Firebird boolean to int",
  SQLTranslator.booleanToInt("WHERE active = TRUE AND deleted = FALSE") === "WHERE active = 1 AND deleted = 0",
);

console.log("\n--- SQL Translation: MSSQL ---");

assert("MSSQL LIMIT to TOP",
  SQLTranslator.limitToTop("SELECT * FROM users LIMIT 10") === "SELECT TOP 10 * FROM users",
);

assert("MSSQL concat pipes to CONCAT",
  SQLTranslator.concatPipesToFunc("first_name || ' ' || last_name") === "CONCAT(first_name, ' ', last_name)",
);

console.log("\n--- SQL Translation: MySQL ---");

assert("MySQL concat pipes to CONCAT",
  SQLTranslator.concatPipesToFunc("a || b") === "CONCAT(a, b)",
);

assert("MySQL ILIKE to LIKE",
  SQLTranslator.ilikeToLike("WHERE name ILIKE '%alice%'") === "WHERE LOWER(name) LIKE LOWER('%alice%')",
);

console.log("\n--- SQL Translation: PostgreSQL ---");

// placeholderStyle converts ? to the engine's positional style. Exercise the
// two documented conversions for real (no `|| true` escape hatch):
//   ":" → :1, :2, ... (Oracle/Firebird, 1-based and incrementing per ?)
//   "%s" → %s         (MySQL/PostgreSQL driver style)
assert("placeholderStyle ? → :N (numbered, incrementing)",
  SQLTranslator.placeholderStyle("SELECT * FROM t WHERE id = ? AND name = ?", ":") ===
  "SELECT * FROM t WHERE id = :1 AND name = :2",
  `got ${JSON.stringify(SQLTranslator.placeholderStyle("SELECT * FROM t WHERE id = ? AND name = ?", ":"))}`,
);

assert("placeholderStyle ? → %s (driver style)",
  SQLTranslator.placeholderStyle("a = ?", "%s") === "a = %s",
  `got ${JSON.stringify(SQLTranslator.placeholderStyle("a = ?", "%s"))}`,
);

console.log("\n--- SQL Translation: Auto-increment DDL ---");

assert("PostgreSQL auto-increment",
  SQLTranslator.autoIncrementSyntax("id INTEGER PRIMARY KEY AUTOINCREMENT", "postgresql") === "id SERIAL PRIMARY KEY",
);

assert("MySQL auto-increment",
  SQLTranslator.autoIncrementSyntax("id INTEGER AUTOINCREMENT", "mysql") === "id INTEGER AUTO_INCREMENT",
);

assert("MSSQL auto-increment",
  SQLTranslator.autoIncrementSyntax("id INTEGER AUTOINCREMENT", "mssql") === "id INTEGER IDENTITY(1,1)",
);

assert("Firebird auto-increment stripped",
  SQLTranslator.autoIncrementSyntax("id INTEGER AUTOINCREMENT", "firebird") === "id INTEGER",
);

// ── Tests requiring running databases (skipped) ──────────────

console.log("\n--- Live Database Tests ---");

skip("PostgreSQL live connection", "Requires running PostgreSQL server");
skip("MySQL live connection", "Requires running MySQL server");
skip("MSSQL live connection", "Requires running MSSQL server");
skip("Firebird live connection", "Requires running Firebird server");

// ── Cleanup ──────────────────────────────────────────────────

try {
  rmSync("/tmp/tina4-driver-test", { recursive: true, force: true });
} catch {
  // ignore
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
