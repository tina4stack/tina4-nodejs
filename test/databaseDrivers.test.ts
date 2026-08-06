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
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDriverlessTree, runDriverless, selftestLine, selftestPassed } from "./_driverlessTree.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

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
// Clear it BEFORE the run, not only after. The cleanup at the bottom of this
// file never executes when the process dies mid-file, and the row-count
// assertions below (fetch-with-limit, fetch-with-skip) then see the previous
// run's rows: `SQLite fetch with skip` reads 2 instead of 1 and reports FAIL on
// a green build. Reproduced by seeding one extra row and re-running.
rmSync("/tmp/tina4-driver-test", { recursive: true, force: true });
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
assert("SQLite tables() lists table", sqlite.getTables().includes("driver_test"));

const cols = sqlite.getColumns("driver_test");
assert("SQLite columns() returns columns", cols.length === 3);
assert("SQLite columns() has id", cols.some((c) => c.name === "id"));
assert("SQLite columns() has primaryKey flag", cols.some((c) => c.name === "id" && c.primaryKey === true));

// Test insert
const insertResult = sqlite.insert("driver_test", { name: "Alice", active: 1 });
assert("SQLite insert success", insertResult.success);
assert("SQLite insert lastId", insertResult.lastId !== undefined && insertResult.lastId !== null);

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
assert("SQLite update affectedRows", updateResult.affectedRows === 1);

// Test delete
const deleteResult = sqlite.delete("driver_test", { name: "Alice Updated" });
assert("SQLite delete success", deleteResult.success);
assert("SQLite delete affectedRows", deleteResult.affectedRows === 1);

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

// Test lastId
sqlite.insert("driver_test", { name: "LastId", active: 1 });
const lid = sqlite.lastInsertId();
assert("SQLite lastId returns number", lid !== null && typeof lid === "number" || typeof lid === "bigint");

closeDatabase();

// ── URL Parsing for New Schemes ──────────────────────────────

console.log("\n--- URL Parsing: MSSQL ---");

const mssql1 = parseDatabaseUrl("mssql://sa:password@dbhost:1433/mydb");
assert("mssql URL type", mssql1.engine === "mssql");
assert("mssql URL host", mssql1.host === "dbhost");
assert("mssql URL port", mssql1.port === 1433);
assert("mssql URL user", mssql1.username === "sa");
assert("mssql URL password", mssql1.password === "password");
assert("mssql URL database", mssql1.database === "mydb");

const mssql2 = parseDatabaseUrl("sqlserver://admin:secret@localhost/testdb");
assert("sqlserver:// alias type", mssql2.engine === "mssql");
assert("sqlserver:// alias user", mssql2.username === "admin");

console.log("\n--- URL Parsing: Firebird ---");

const fb1 = parseDatabaseUrl("firebird://SYSDBA:masterkey@localhost:3050/var/data/test.fdb");
assert("firebird URL type", fb1.engine === "firebird");
assert("firebird URL host", fb1.host === "localhost");
assert("firebird URL port", fb1.port === 3050);
assert("firebird URL user", fb1.username === "SYSDBA");
// ONE slash after the port is the URL path separator, so this path is
// RELATIVE. The old parser did `"/" + path`, silently promoting every
// Firebird path to absolute; the documented absolute form uses two.
assert("firebird one slash stays relative", fb1.database === "var/data/test.fdb");
const fb1abs = parseDatabaseUrl("firebird://SYSDBA:masterkey@localhost:3050//var/data/test.fdb");
assert("firebird two slashes is absolute", fb1abs.database === "/var/data/test.fdb");

// ── Missing Package Errors ───────────────────────────────────
//
// These four assert the error a developer gets when a driver is ABSENT. They
// used to run in THIS process, where every driver is installed by design, so
// the condition they test could not exist: all four took the else-branch and
// printed `SKIP ... package is installed` on every run since they were written.
// The missing-driver path — the one an app hits on its first deploy without an
// optional peer dependency — was exercised NOWHERE.
//
// A shim was NOT the answer. Patching `Module._resolveFilename` to throw a
// hand-made MODULE_NOT_FOUND mocks the module resolver, which is the exact
// collaborator whose real behaviour these tests exist to observe: it would
// prove the adapter's catch handles the error the TEST fabricated. That is what
// the deleted test/_hidePackages.mjs did.
//
// Instead the source is COPIED OUT of the repository into a temp tree with no
// node_modules anywhere above it and run with plain
// `node --experimental-strip-types` (test/_driverlessTree.ts, shared with
// sessionZeroDependencyFallback.test.ts). All four adapters reach for their
// driver through `createRequire(import.meta.url)`, which resolves from the
// ADAPTER's directory, so inside that tree the failure is the real resolver's —
// nothing is stubbed or intercepted.
//
// THE INSTRUMENT IS ASSERTED FIRST. The child counts how many of the four
// drivers it can still resolve — from packages/orm/src/adapters/postgres.ts,
// the very file that does the resolving — and that count must be 0. A child
// that quietly inherited a node_modules would make all four cases pass while
// proving nothing.
//
// And each case has a NEGATIVE CONTROL below it: with the driver PRESENT, the
// same call must NOT produce the missing-package message. Without that, an
// adapter that threw "install pg" unconditionally would pass all four.

console.log("\n--- Missing Package Errors (real, unresolvable drivers) ---");

/** The four adapters, their driver package, and a URL that never gets used. */
const DRIVERS = [
  { label: "PostgreSQL", pkg: "pg", ctor: "PostgresAdapter", file: "postgres", url: "postgresql://localhost/test" },
  { label: "MySQL", pkg: "mysql2", ctor: "MysqlAdapter", file: "mysql", url: "mysql://localhost/test" },
  { label: "MSSQL", pkg: "tedious", ctor: "MssqlAdapter", file: "mssql", url: "mssql://localhost/test" },
  { label: "Firebird", pkg: "node-firebird", ctor: "FirebirdAdapter", file: "firebird", url: "firebird://localhost/test.fdb" },
];

/**
 * Is this the "you need to install the driver" error, for THIS package?
 *
 * Deliberately tighter than the old `includes("pg") && includes("requires")`,
 * which every one of these messages satisfies for every other package too
 * ("PostgreSQL adapter requires..." contains "requires"), and which an
 * ECONNREFUSED naming a `pg`-something host could also satisfy. It must name
 * the package AND carry the remedy.
 */
function isMissingPackageError(message: string, pkg: string): boolean {
  return message.includes(`requires the "${pkg}" package`) && message.includes(`npm install ${pkg}`);
}

const driverlessRoot = buildDriverlessTree(REPO);
try {
  const imports = DRIVERS
    .map((d) => `import { ${d.ctor} } from "./packages/orm/src/adapters/${d.file}.ts";`)
    .join("\n");
  const cases = DRIVERS
    .map((d) => `  [${JSON.stringify(d.pkg)}, () => new ${d.ctor}(${JSON.stringify(d.url)})],`)
    .join("\n");

  // writeSync + an explicit exit, both deliberate. console.log to a PIPE is
  // asynchronous, so a child that exits immediately after it can lose the very
  // line the parent parses; and when the instrument is WORKING the drivers are
  // unresolvable so connect() throws before any socket exists — but when it is
  // BROKEN the drivers load, real sockets stay open, and a child with no exit
  // hangs until the timeout instead of failing in a second.
  let output = "";
  let childError = "";
  try {
    output = runDriverless(driverlessRoot, `
${imports}
import { writeSync } from "node:fs";

const cases: Array<[string, () => any]> = [
${cases}
];

for (const [pkg, make] of cases) {
  let outcome = "connect() RESOLVED — no error at all";
  try {
    await make().connect();
  } catch (err) {
    outcome = String((err as Error)?.message ?? err);
  }
  writeSync(1, "CASE " + pkg + " " + JSON.stringify(outcome) + "\\n");
}
process.exit(0);
`, {
      packages: DRIVERS.map((d) => d.pkg),
      resolveFrom: "packages/orm/src/adapters/postgres.ts",
    });
  } catch (err) {
    // A child that dies is a RED result for all five assertions below, never an
    // exception that takes the whole file down with a stack trace.
    const e = err as { stdout?: string; message?: string };
    output = String(e.stdout ?? "");
    childError = String(e.message ?? err).split("\n")[0];
  }

  assert(
    "the driverless child can resolve NONE of the four drivers (instrument)",
    childError === "" && selftestPassed(output),
    `${selftestLine(output)}${childError ? ` / child died: ${childError}` : ""} — the child resolved a `
    + "driver it was supposed to be denied, so every case below would pass while proving nothing",
  );

  for (const driver of DRIVERS) {
    const line = output.split("\n").find((l) => l.startsWith(`CASE ${driver.pkg} `));
    const message = line ? String(JSON.parse(line.slice(`CASE ${driver.pkg} `.length))) : "";
    assert(
      `${driver.label} missing package error`,
      childError === "" && selftestPassed(output) && isMissingPackageError(message, driver.pkg),
      `got ${JSON.stringify(message.split("\n")[0] || "(no CASE line)")} — expected the message to name `
      + `the "${driver.pkg}" package and give "npm install ${driver.pkg}"`,
    );
  }
} finally {
  rmSync(driverlessRoot, { recursive: true, force: true });
}

// NEGATIVE CONTROL — the inverse of every case above, in THIS process, where
// all four drivers ARE installed. Each adapter is pointed at a genuinely closed
// port (bound then released, so nothing can be listening on it), so connect()
// fails for a real transport reason. The missing-package message must NOT be
// that reason. Without this pair, an adapter whose requireX() threw
// unconditionally — a one-character mistake in the try block — passes all four
// assertions above.
console.log("\n--- Missing Package Errors: negative control (drivers installed) ---");

/** A port nothing can be listening on: bind it, read it, release it. */
function closedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

{
  const deadPort = await closedLoopbackPort();
  // Keep a refused connection from ever waiting on the 10s default bound.
  const savedTimeout = process.env.TINA4_DATABASE_CONNECT_TIMEOUT;
  process.env.TINA4_DATABASE_CONNECT_TIMEOUT = "5";
  const present: Array<{ label: string; pkg: string; make: () => { connect(): Promise<void> } }> = [
    { label: "PostgreSQL", pkg: "pg", make: () => new PostgresAdapter(`postgresql://u:p@127.0.0.1:${deadPort}/test`) },
    { label: "MySQL", pkg: "mysql2", make: () => new MysqlAdapter(`mysql://u:p@127.0.0.1:${deadPort}/test`) },
    { label: "MSSQL", pkg: "tedious", make: () => new MssqlAdapter(`mssql://u:p@127.0.0.1:${deadPort}/test`) },
    { label: "Firebird", pkg: "node-firebird", make: () => new FirebirdAdapter(`firebird://u:p@127.0.0.1:${deadPort}/test.fdb`) },
  ];
  for (const engine of present) {
    // Resolve it the way the adapter does. If the driver genuinely is not
    // installed here, the control cannot run and says so rather than passing.
    let installed = true;
    try { createRequire(import.meta.url).resolve(engine.pkg); } catch { installed = false; }
    let message = "connect() resolved";
    try { await engine.make().connect(); } catch (err) { message = String((err as Error)?.message ?? err); }
    assert(
      `${engine.label} does NOT report a missing package when ${engine.pkg} is installed`,
      installed && !isMissingPackageError(message, engine.pkg),
      installed
        ? `got ${JSON.stringify(message.split("\n")[0])} — the adapter blamed a missing driver that is present`
        : `the ${engine.pkg} package is not resolvable in this process, so the control proves nothing`,
    );
  }
  if (savedTimeout === undefined) delete process.env.TINA4_DATABASE_CONNECT_TIMEOUT;
  else process.env.TINA4_DATABASE_CONNECT_TIMEOUT = savedTimeout;
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

// ── Live database connections ────────────────────────────────
//
// These four were UNCONDITIONAL STUBS -- `skip("PostgreSQL live connection",
// "Requires running PostgreSQL server")` with no code behind them. The message
// implied a missing server; in fact no test existed to run, and the lab has had
// PostgreSQL, MySQL, MSSQL and Firebird up the whole time. Four permanent skips
// reading as "environment not set up".
//
// Each now connects for real and reads a row back, addressed by the canonical
// TINA4_TEST_<ENGINE>_URL (ADR-0038). Absent that variable they still skip, but
// the reason names the variable to set rather than blaming the server.

console.log("\n--- Live Database Tests ---");

const LIVE: Array<{
  label: string;
  pkg: string;
  env: string[];
  make: (url: string) => any;
  probe: string;
  expect: number;
}> = [
  // TINA4_TEST_PG_URL only -- TINA4_TEST_POSTGRES_URL is its deprecated alias
  // and testEnvContract rejects it, which is exactly what that gate is for.
  { label: "PostgreSQL", pkg: "pg", env: ["TINA4_TEST_PG_URL"],
    make: (u) => new PostgresAdapter(u), probe: "SELECT 1 AS n", expect: 1 },
  { label: "MySQL", pkg: "mysql2", env: ["TINA4_TEST_MYSQL_URL"],
    make: (u) => new MysqlAdapter(u), probe: "SELECT 1 AS n", expect: 1 },
  { label: "MSSQL", pkg: "tedious", env: ["TINA4_TEST_MSSQL_URL"],
    make: (u) => new MssqlAdapter(u), probe: "SELECT 1 AS n", expect: 1 },
  { label: "Firebird", pkg: "node-firebird", env: ["TINA4_TEST_FIREBIRD_URL"],
    make: (u) => new FirebirdAdapter(u), probe: "SELECT 1 AS n FROM RDB$DATABASE", expect: 1 },
];

for (const spec of LIVE) {
  const name = `${spec.label} live connection`;
  const url = spec.env.map((e) => process.env[e]).find((v) => v && v.trim() !== "");
  if (!url) {
    skip(name, `set ${spec.env[0]} to point at a live ${spec.label} (the lab exports it)`);
    continue;
  }
  // A driver that is genuinely not installed means this test cannot run here --
  // it is not evidence of a broken adapter. Resolve it the same way the adapter
  // does, so the two agree. (The missing-driver cases above no longer need a
  // second pass with the drivers hidden from this process: they run in a child
  // that cannot resolve them, so this process always has them.)
  try {
    createRequire(import.meta.url).resolve(spec.pkg);
  } catch {
    skip(name, `the ${spec.pkg} package is not installed`);
    continue;
  }

  const db = spec.make(url);
  try {
    await db.connect();
    const row: any = await db.fetchOneAsync(spec.probe);
    const value = row ? Number(Object.values(row)[0]) : NaN;
    assert(name, value === spec.expect);
  } catch (err) {
    // With the driver PRESENT and a server CONFIGURED, a failure is a FAILURE,
    // never a skip -- skipping here is how a broken adapter hides behind "no
    // server", which is the exact defect these four replaced.
    assert(`${name} — ${(err as Error).message.split("\n")[0]}`, false);
  } finally {
    try { await db.close?.(); } catch { /* already gone */ }
  }
}

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
